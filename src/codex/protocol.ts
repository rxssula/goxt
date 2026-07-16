import { Deferred, Effect, Queue, Ref, Semaphore, Stream } from "effect"
import type { RpcNotification, RpcServerRequest } from "./generated/protocol.js"
import { CodexProtocolError, CodexRpcError } from "./types.js"

type RpcFailure = CodexProtocolError | CodexRpcError
type PendingRequest = Deferred.Deferred<unknown, RpcFailure>
type AppServerProcess = Bun.Subprocess<"pipe", "pipe", "pipe">

export type RpcMessage =
  | RpcNotification
  | RpcServerRequest
  | {
      readonly id: number | string
      readonly result?: unknown
      readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
    }

export interface Interface {
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, RpcFailure>
  readonly notify: (method: string, params: unknown) => Effect.Effect<void, CodexProtocolError>
  readonly respond: (id: number | string, result: unknown) => Effect.Effect<void, CodexProtocolError>
  readonly respondError: (
    id: number | string,
    code: number,
    message: string,
  ) => Effect.Effect<void, CodexProtocolError>
  readonly notifications: Stream.Stream<RpcNotification>
  readonly serverRequests: Stream.Stream<RpcServerRequest>
  readonly closed: Effect.Effect<void, CodexProtocolError>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isId = (value: unknown): value is number | string =>
  typeof value === "number" || typeof value === "string"

export const parseRpcMessage = (line: string): Effect.Effect<RpcMessage, CodexProtocolError> =>
  Effect.try({
    try: () => {
      const value: unknown = JSON.parse(line)
      if (!isRecord(value)) throw new Error("message is not an object")

      if (typeof value.method === "string") {
        if (isId(value.id)) {
          return { id: value.id, method: value.method, params: value.params } satisfies RpcServerRequest
        }
        return { method: value.method, params: value.params } satisfies RpcNotification
      }

      if (isId(value.id) && ("result" in value || "error" in value)) {
        if ("error" in value && value.error !== undefined) {
          if (!isRecord(value.error)) throw new Error("response error is not an object")
          if (typeof value.error.code !== "number" || typeof value.error.message !== "string") {
            throw new Error("response error has an unexpected shape")
          }
          return {
            id: value.id,
            error: {
              code: value.error.code,
              message: value.error.message,
              ...(value.error.data === undefined ? {} : { data: value.error.data }),
            },
          }
        }
        return { id: value.id, result: value.result }
      }

      throw new Error("message is neither a request, notification, nor response")
    },
    catch: () =>
      new CodexProtocolError({
        message: "Codex app-server emitted an invalid JSON-RPC message.",
        line,
      }),
  })

export async function* jsonLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) yield line
        newline = buffer.indexOf("\n")
      }
    }

    buffer += decoder.decode()
    const finalLine = buffer.trim()
    if (finalLine) yield finalLine
  } finally {
    reader.releaseLock()
  }
}

export const make = Effect.fn("CodexProtocol.make")(function* (
  process: AppServerProcess,
) {
  const nextId = yield* Ref.make(1)
  const pending = yield* Ref.make<ReadonlyMap<number | string, PendingRequest>>(new Map())
  const notifications = yield* Queue.unbounded<RpcNotification>()
  const serverRequests = yield* Queue.unbounded<RpcServerRequest>()
  const closed = yield* Deferred.make<void, CodexProtocolError>()
  const writeLock = yield* Semaphore.make(1)
  const stderrPromise = new Response(process.stderr).text()

  const removePending = Effect.fn("CodexProtocol.removePending")(function* (id: number | string) {
    return yield* Ref.modify(pending, (requests) => {
      const deferred = requests.get(id)
      const next = new Map(requests)
      next.delete(id)
      return [deferred, next] as const
    })
  })

  const failPending = Effect.fn("CodexProtocol.failPending")(function* (
    error: CodexProtocolError,
  ) {
    const requests = yield* Ref.getAndSet(pending, new Map())
    yield* Effect.forEach(requests.values(), (deferred) => Deferred.fail(deferred, error), {
      discard: true,
    })
  })

  const closeWith = Effect.fn("CodexProtocol.closeWith")(function* (error: CodexProtocolError) {
    yield* failPending(error)
    yield* Deferred.fail(closed, error)
    yield* Queue.shutdown(notifications)
    yield* Queue.shutdown(serverRequests)
  })

  const write = Effect.fn("CodexProtocol.write")(function* (message: unknown) {
    yield* writeLock.withPermit(Effect.tryPromise({
      try: async () => {
        await process.stdin.write(`${JSON.stringify(message)}\n`)
        await process.stdin.flush()
      },
      catch: () =>
        new CodexProtocolError({
          message: "Could not write to the Codex app-server process.",
        }),
    }))
  })

  const route = Effect.fn("CodexProtocol.route")(function* (message: RpcMessage) {
    if ("method" in message) {
      if ("id" in message) yield* Queue.offer(serverRequests, message)
      else yield* Queue.offer(notifications, message)
      return
    }

    const deferred = yield* removePending(message.id)
    if (deferred === undefined) return

    if (message.error !== undefined) {
      yield* Deferred.fail(
        deferred,
        new CodexRpcError({
          message: message.error.message,
          code: message.error.code,
          ...(message.error.data === undefined ? {} : { data: message.error.data }),
        }),
      )
      return
    }
    yield* Deferred.succeed(deferred, message.result)
  })

  yield* Stream.fromAsyncIterable(
    jsonLines(process.stdout),
    () => new CodexProtocolError({ message: "Could not read from Codex app-server." }),
  ).pipe(
    Stream.mapEffect(parseRpcMessage),
    Stream.runForEach(route),
    Effect.matchEffect({
      onFailure: closeWith,
      onSuccess: () =>
        closeWith(
          new CodexProtocolError({ message: "Codex app-server closed its output stream." }),
        ),
    }),
    Effect.forkScoped({ startImmediately: true }),
  )

  yield* Effect.tryPromise({
    try: async () => {
      const [exitCode, stderr] = await Promise.all([process.exited, stderrPromise])
      return { exitCode, stderr: stderr.trim() }
    },
    catch: () => ({ exitCode: 1, stderr: "" }),
  }).pipe(
    Effect.flatMap(({ exitCode, stderr }) =>
      closeWith(
        new CodexProtocolError({
          message: stderr || `Codex app-server exited with status ${exitCode}.`,
        }),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )

  const request = Effect.fn("CodexProtocol.request")(function* (
    method: string,
    params: unknown,
  ) {
    const id = yield* Ref.getAndUpdate(nextId, (value) => value + 1)
    const deferred = yield* Deferred.make<unknown, RpcFailure>()
    yield* Ref.update(pending, (requests) => new Map(requests).set(id, deferred))

    const awaitResponse = Effect.raceFirst(
      Effect.gen(function* () {
        yield* write({ id, method, params })
        return yield* Deferred.await(deferred)
      }),
      Deferred.await(closed),
    ).pipe(Effect.ensuring(removePending(id)))

    return yield* awaitResponse
  })

  const notify = Effect.fn("CodexProtocol.notify")(function* (method: string, params: unknown) {
    yield* write({ method, params })
  })

  const respond = Effect.fn("CodexProtocol.respond")(function* (
    id: number | string,
    result: unknown,
  ) {
    yield* write({ id, result })
  })

  const respondError = Effect.fn("CodexProtocol.respondError")(function* (
    id: number | string,
    code: number,
    message: string,
  ) {
    yield* write({ id, error: { code, message } })
  })

  return {
    request,
    notify,
    respond,
    respondError,
    notifications: Stream.fromQueue(notifications),
    serverRequests: Stream.fromQueue(serverRequests),
    closed: Deferred.await(closed),
  }
})

export * as CodexProtocol from "./protocol.js"
