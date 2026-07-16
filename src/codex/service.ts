import { Context, Deferred, Effect, Layer, Ref, Schema, Stream } from "effect"
import { parseCodexNotification, parseCodexServerRequest } from "./event.js"
import type { ToolRequestUserInputResponse } from "./generated/protocol.js"
import { CodexProtocol } from "./protocol.js"
import {
  CodexNotAuthenticated,
  CodexProcessError,
  CodexProtocolError,
  CodexRpcError,
  type ApprovalDecision,
  type CodexEvent,
  type CodexModel,
  type CodexRateLimits,
  type CodexSession,
  type CodexSessionHistory,
  type CodexRunError,
  type CodexRunRequest,
  type CodexStatus,
  CodexUnavailable,
  unsupportedApprovalMessage,
} from "./types.js"

export interface Interface {
  readonly status: () => Effect.Effect<CodexStatus>
  readonly listModels: () => Effect.Effect<ReadonlyArray<CodexModel>, CodexRunError>
  readonly readRateLimits: () => Effect.Effect<CodexRateLimits, CodexRunError>
  readonly listSessions: (cwd: string) => Effect.Effect<ReadonlyArray<CodexSession>, CodexRunError>
  readonly readSessionHistory: (sessionId: string) => Effect.Effect<CodexSessionHistory, CodexRunError>
  readonly run: (
    request: CodexRunRequest,
    onEvent: (event: CodexEvent) => void,
  ) => Effect.Effect<string, CodexRunError>
  readonly steer: (prompt: string) => Effect.Effect<void, CodexRunError>
  readonly interrupt: () => Effect.Effect<void, CodexRunError>
  readonly respondApproval: (
    requestId: number | string,
    decision: ApprovalDecision,
  ) => Effect.Effect<void, CodexProtocolError>
  readonly respondUserInput: (
    requestId: number | string,
    response: ToolRequestUserInputResponse,
  ) => Effect.Effect<void, CodexProtocolError>
}

export class Service extends Context.Service<Service, Interface>()("@goxt/CodexAppServer") {}

interface ActiveRun {
  readonly completion: Deferred.Deferred<string, CodexRunError>
  readonly onEvent: (event: CodexEvent) => void
  readonly threadId?: string
  readonly turnId?: string
}

const ThreadResponse = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) })
const TurnResponse = Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) })
const SteerResponse = Schema.Struct({ turnId: Schema.String })
const ModelListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      model: Schema.String,
      displayName: Schema.String,
      description: Schema.String,
      supportedReasoningEfforts: Schema.Array(
        Schema.Struct({
          reasoningEffort: Schema.String,
          description: Schema.String,
        }),
      ),
      defaultReasoningEffort: Schema.String,
      isDefault: Schema.Boolean,
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
})
const RateLimitWindow = Schema.Struct({
  usedPercent: Schema.Number,
  windowDurationMins: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(Schema.Number),
})
const RateLimitSnapshot = Schema.Struct({
  limitId: Schema.NullOr(Schema.String),
  limitName: Schema.NullOr(Schema.String),
  primary: Schema.NullOr(RateLimitWindow),
  secondary: Schema.NullOr(RateLimitWindow),
  planType: Schema.NullOr(Schema.String),
})
const RateLimitsResponse = Schema.Struct({
  rateLimits: RateLimitSnapshot,
  rateLimitsByLimitId: Schema.optionalKey(
    Schema.NullOr(Schema.Record(Schema.String, RateLimitSnapshot)),
  ),
})
const ThreadStatus = Schema.Union([
  Schema.Struct({ type: Schema.Literal("notLoaded") }),
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({ type: Schema.Literal("systemError") }),
  Schema.Struct({
    type: Schema.Literal("active"),
    activeFlags: Schema.Array(Schema.String),
  }),
])
const ThreadListResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({
    id: Schema.String,
    preview: Schema.String,
    name: Schema.NullOr(Schema.String),
    cwd: Schema.String,
    updatedAt: Schema.Number,
    status: ThreadStatus,
  })),
  nextCursor: Schema.NullOr(Schema.String),
})
const ThreadReadResponse = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.String,
    preview: Schema.String,
    name: Schema.NullOr(Schema.String),
    cwd: Schema.String,
    updatedAt: Schema.Number,
    status: ThreadStatus,
    turns: Schema.Array(Schema.Struct({ items: Schema.Array(Schema.Unknown) })),
  }),
})

const sessionStatus = (status: Schema.Schema.Type<typeof ThreadStatus>): CodexSession["status"] =>
  status.type === "active"
    ? status.activeFlags.length > 0 ? "waiting" : "active"
    : status.type

const sessionSummary = (thread: {
  readonly id: string
  readonly preview: string
  readonly name: string | null
  readonly cwd: string
  readonly updatedAt: number
  readonly status: Schema.Schema.Type<typeof ThreadStatus>
}): CodexSession => ({
  id: thread.id,
  title: thread.name?.trim() || thread.preview.trim() || "Untitled session",
  cwd: thread.cwd,
  updatedAt: thread.updatedAt,
  status: sessionStatus(thread.status),
})

const readProcess = async (process: Bun.Subprocess<"ignore", "pipe", "pipe">) => {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

const probe = async (args: ReadonlyArray<string>) => {
  try {
    const process = Bun.spawn([...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    return await readProcess(process)
  } catch {
    return { stdout: "", stderr: "", exitCode: 127 }
  }
}

const decodeResponse = <A, E>(
  schema: Schema.Codec<A, E, never, never>,
  value: unknown,
  operation: string,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () =>
        new CodexProtocolError({
          message: `Codex returned an unexpected response to ${operation}.`,
        }),
    ),
  )

const textInput = (text: string) => [{ type: "text" as const, text, text_elements: [] }]

export const canReuseThread = (
  currentThreadId: string | undefined,
  requestedSessionId: string | undefined,
): currentThreadId is string =>
  currentThreadId !== undefined && currentThreadId === requestedSessionId

export const getInterruptTarget = (
  threadId: string | undefined,
  turnId: string | undefined,
): { readonly threadId: string; readonly turnId: string } | undefined =>
  threadId === undefined || turnId === undefined ? undefined : { threadId, turnId }

export const rejectUnsupportedApproval = Effect.fn("CodexAppServer.rejectUnsupportedApproval")(
  function* (
    protocol: Pick<CodexProtocol.Interface, "respondError">,
    requestId: number | string,
    event: CodexEvent,
  ) {
    if (event._tag !== "ApprovalRequested" || event.availableDecisions.length > 0) return false
    yield* protocol.respondError(requestId, -32_602, unsupportedApprovalMessage)
    return true
  },
)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.spawn(["codex", "app-server", "--stdio"], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          }),
        catch: () =>
          new CodexUnavailable({
            message: "Codex CLI was not found. Install it and run `codex login`.",
          }),
      }),
      (child) =>
        Effect.promise(async () => {
          try {
            await child.stdin.end()
          } catch {
            // The pipe may already be closed.
          }
          try {
            child.kill("SIGTERM")
          } catch {
            // The process may already have exited.
          }
        }),
    )

    const protocol = yield* CodexProtocol.make(process)
    const currentThreadId = yield* Ref.make<string | undefined>(undefined)
    const activeRun = yield* Ref.make<ActiveRun | undefined>(undefined)

    yield* protocol.request("initialize", {
      clientInfo: { name: "goxt", title: "goxt", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    })
    yield* protocol.notify("initialized", {})

    const emit = Effect.fn("CodexAppServer.emit")(function* (event: CodexEvent) {
      const active = yield* Ref.get(activeRun)
      if (active === undefined) return
      yield* Effect.sync(() => {
        try {
          active.onEvent(event)
        } catch {
          // Rendering failures must not stop the protocol consumer.
        }
      })
    })

    const handleNotification = Effect.fn("CodexAppServer.handleNotification")(
      function* (notification) {
        const event = yield* parseCodexNotification(notification)

        if (event._tag === "ThreadStarted") {
          yield* Ref.set(currentThreadId, event.threadId)
          yield* Ref.update(activeRun, (active) =>
            active === undefined ? undefined : { ...active, threadId: event.threadId },
          )
        } else if (event._tag === "TurnStarted") {
          yield* Ref.update(activeRun, (active) =>
            active === undefined ? undefined : { ...active, turnId: event.turnId },
          )
        }

        yield* emit(event)

        const active = yield* Ref.get(activeRun)
        if (active === undefined) return
        if (event._tag === "TurnCompleted" && active.turnId === event.turnId) {
          yield* Deferred.succeed(active.completion, event.status)
        } else if (event._tag === "TurnFailed") {
          yield* Deferred.fail(
            active.completion,
            new CodexProcessError({ message: event.message, exitCode: 1 }),
          )
        }
      },
    )

    const handleServerRequest = Effect.fn("CodexAppServer.handleServerRequest")(
      function* (request) {
        if (request.method === "currentTime/read") {
          yield* protocol.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1_000) })
          return
        }

        const event = yield* parseCodexServerRequest(request)
        if (event._tag === "Unknown") {
          yield* protocol.respondError(request.id, -32601, `Unsupported request: ${request.method}`)
          return
        }

        const rejected = yield* rejectUnsupportedApproval(protocol, request.id, event)
        const active = yield* Ref.get(activeRun)
        if (rejected) {
          if (active !== undefined) yield* emit(event)
          return
        }
        if (active === undefined) {
          if (event._tag === "ApprovalRequested") {
            yield* protocol.respond(request.id, { decision: "cancel" })
          } else {
            yield* protocol.respond(request.id, { answers: {} })
          }
          return
        }
        yield* emit(event)
      },
    )

    yield* protocol.notifications.pipe(
      Stream.runForEach((notification) =>
        handleNotification(notification).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* emit({ _tag: "TurnFailed", message: error.message })
              const active = yield* Ref.get(activeRun)
              if (active !== undefined) yield* Deferred.fail(active.completion, error)
            }),
          ),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* protocol.serverRequests.pipe(
      Stream.runForEach((request) =>
        handleServerRequest(request).pipe(
          Effect.catch(() =>
            protocol.respondError(request.id, -32_602, "Invalid app-server request payload."),
          ),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    // Register this after the reader fibers so scope shutdown closes stdout first;
    // otherwise an interrupted Web ReadableStream can remain parked in reader.read().
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          process.kill("SIGTERM")
        } catch {
          // The process may already have exited.
        }
      }),
    )

    const status = Effect.fn("CodexAppServer.status")(function* () {
      const versionResult = yield* Effect.promise(() => probe(["codex", "--version"]))
      if (versionResult.exitCode !== 0) {
        return { available: false, authenticated: false, version: "not found" }
      }

      const loginResult = yield* Effect.promise(() => probe(["codex", "login", "status"]))
      return {
        available: true,
        authenticated: loginResult.exitCode === 0,
        version: versionResult.stdout.replace(/^codex-cli\s+/, "") || "unknown",
      }
    })

    const listModels = Effect.fn("CodexAppServer.listModels")(function* () {
      const response = yield* protocol.request("model/list", {
        limit: 100,
        includeHidden: false,
      })
      const decoded = yield* decodeResponse(ModelListResponse, response, "model/list")
      return decoded.data
    })

    const readRateLimits = Effect.fn("CodexAppServer.readRateLimits")(function* () {
      const response = yield* protocol.request("account/rateLimits/read", undefined)
      const decoded = yield* decodeResponse(RateLimitsResponse, response, "account/rateLimits/read")
      return {
        rateLimits: decoded.rateLimits,
        rateLimitsByLimitId: decoded.rateLimitsByLimitId ?? null,
      } satisfies CodexRateLimits
    })

    const listSessions = Effect.fn("CodexAppServer.listSessions")(function* (cwd: string) {
      const response = yield* protocol.request("thread/list", {
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        cwd,
        archived: false,
      })
      const decoded = yield* decodeResponse(ThreadListResponse, response, "thread/list")
      return decoded.data.map(sessionSummary)
    })

    const readSessionHistory = Effect.fn("CodexAppServer.readSessionHistory")(function* (
      sessionId: string,
    ) {
      const response = yield* protocol.request("thread/read", { threadId: sessionId, includeTurns: true })
      const decoded = yield* decodeResponse(ThreadReadResponse, response, "thread/read")
      const messages: CodexSessionHistory["messages"][number][] = []
      for (const turn of decoded.thread.turns) {
        for (const item of turn.items) {
          if (typeof item !== "object" || item === null || !("type" in item)) continue
          if (item.type === "agentMessage" && "text" in item && typeof item.text === "string") {
            if (item.text.trim()) messages.push({ role: "assistant", text: item.text })
          } else if (item.type === "userMessage" && "content" in item && Array.isArray(item.content)) {
            const text = item.content.flatMap((part) =>
              typeof part === "object" && part !== null && "type" in part && part.type === "text" &&
              "text" in part && typeof part.text === "string" ? [part.text] : [],
            ).join("\n")
            if (text.trim()) messages.push({ role: "user", text })
          }
        }
      }
      return { session: sessionSummary(decoded.thread), messages }
    })

    const ensureThread = Effect.fn("CodexAppServer.ensureThread")(function* (
      request: CodexRunRequest,
    ) {
      const existing = yield* Ref.get(currentThreadId)
      if (canReuseThread(existing, request.sessionId)) return existing

      const response = request.sessionId
        ? yield* protocol.request("thread/resume", {
            threadId: request.sessionId,
            cwd: request.cwd,
            approvalPolicy: "never",
            sandbox: "workspace-write",
            excludeTurns: true,
          })
        : yield* protocol.request("thread/start", {
            cwd: request.cwd,
            approvalPolicy: "never",
            sandbox: "workspace-write",
            experimentalRawEvents: false,
          })
      const decoded = yield* decodeResponse(ThreadResponse, response, "thread start/resume")
      yield* Ref.set(currentThreadId, decoded.thread.id)
      yield* Ref.update(activeRun, (active) =>
        active === undefined ? undefined : { ...active, threadId: decoded.thread.id },
      )
      return decoded.thread.id
    })

    const run = Effect.fn("CodexAppServer.run")(function* (
      request: CodexRunRequest,
      onEvent: (event: CodexEvent) => void,
    ) {
      const existing = yield* Ref.get(activeRun)
      if (existing !== undefined) {
        return yield* Effect.fail(
          new CodexRpcError({ message: "A Codex turn is already active.", code: -32_000 }),
        )
      }

      const completion = yield* Deferred.make<string, CodexRunError>()
      yield* Ref.set(activeRun, { completion, onEvent })

      const classifyRpcError = (
        error: CodexRpcError,
      ): Effect.Effect<never, CodexRpcError | CodexNotAuthenticated> =>
        /not logged in|login required|authentication/i.test(error.message)
          ? Effect.fail(
              new CodexNotAuthenticated({
                message: "Codex is not authenticated. Run `codex login` and try again.",
              }),
            )
          : Effect.fail(error)

      const workflow = Effect.gen(function* () {
        const threadId = yield* ensureThread(request)
        const response = yield* protocol.request("turn/start", {
          threadId,
          input: textInput(request.prompt),
          cwd: request.cwd,
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.reasoningEffort === undefined ? {} : { effort: request.reasoningEffort }),
        })
        const decoded = yield* decodeResponse(TurnResponse, response, "turn/start")
        yield* Ref.update(activeRun, (active) =>
          active === undefined ? undefined : { ...active, threadId, turnId: decoded.turn.id },
        )
        return yield* Effect.raceFirst(
          Deferred.await(completion),
          protocol.closed.pipe(Effect.andThen(Effect.never)),
        )
      }).pipe(
        Effect.catchTag("CodexRpcError", classifyRpcError),
        Effect.ensuring(
          Ref.update(activeRun, (active) =>
            active?.completion === completion ? undefined : active,
          ),
        ),
      )

      return yield* workflow
    })

    const steer = Effect.fn("CodexAppServer.steer")(function* (prompt: string) {
      const active = yield* Ref.get(activeRun)
      if (active?.threadId === undefined || active.turnId === undefined) {
        return yield* Effect.fail(
          new CodexRpcError({ message: "There is no active turn to steer.", code: -32_001 }),
        )
      }
      const response = yield* protocol.request("turn/steer", {
        threadId: active.threadId,
        input: textInput(prompt),
        expectedTurnId: active.turnId,
      })
      yield* decodeResponse(SteerResponse, response, "turn/steer")
    })

    const interrupt = Effect.fn("CodexAppServer.interrupt")(function* () {
      const active = yield* Ref.get(activeRun)
      const target = getInterruptTarget(active?.threadId, active?.turnId)
      if (target === undefined) {
        return yield* Effect.fail(
          new CodexRpcError({ message: "There is no active turn to interrupt.", code: -32_001 }),
        )
      }
      yield* Effect.raceFirst(
        protocol.request("turn/interrupt", {
          threadId: target.threadId,
          turnId: target.turnId,
        }),
        Effect.sleep("5 seconds").pipe(
          Effect.andThen(
            Effect.fail(
              new CodexProtocolError({ message: "Codex did not acknowledge the interrupt." }),
            ),
          ),
        ),
      )
    })

    const respondApproval = Effect.fn("CodexAppServer.respondApproval")(function* (
      requestId: number | string,
      decision: ApprovalDecision,
    ) {
      yield* protocol.respond(requestId, { decision })
    })

    const respondUserInput = Effect.fn("CodexAppServer.respondUserInput")(function* (
      requestId: number | string,
      response: ToolRequestUserInputResponse,
    ) {
      yield* protocol.respond(requestId, response)
    })

    return Service.of({
      status,
      listModels,
      readRateLimits,
      listSessions,
      readSessionHistory,
      run,
      steer,
      interrupt,
      respondApproval,
      respondUserInput,
    })
  }),
)

export * as CodexAppServer from "./service.js"
