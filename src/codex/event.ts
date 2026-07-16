import { Effect, Schema } from "effect"
import type { RpcNotification, RpcServerRequest } from "./generated/protocol.js"
import { CodexProtocolError, type ApprovalDecision, type CodexEvent } from "./types.js"

const ThreadStarted = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) })
const TurnLifecycle = Schema.Struct({
  turn: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    error: Schema.NullOr(Schema.Struct({ message: Schema.String })),
  }),
})
const AgentMessageDelta = Schema.Struct({ itemId: Schema.String, delta: Schema.String })
const OutputDelta = Schema.Struct({ itemId: Schema.String, delta: Schema.String })
const ItemLifecycle = Schema.Struct({
  item: Schema.Struct({
    id: Schema.String,
    type: Schema.String,
    text: Schema.optionalKey(Schema.String),
    command: Schema.optionalKey(Schema.String),
    server: Schema.optionalKey(Schema.String),
    tool: Schema.optionalKey(Schema.String),
  }),
})
const PlanUpdated = Schema.Struct({
  explanation: Schema.NullOr(Schema.String),
  plan: Schema.Array(Schema.Struct({ step: Schema.String, status: Schema.String })),
})
const TokenUsage = Schema.Struct({
  tokenUsage: Schema.Struct({
    total: Schema.Struct({ totalTokens: Schema.Number }),
    last: Schema.Struct({ totalTokens: Schema.Number }),
    modelContextWindow: Schema.NullOr(Schema.Number),
  }),
})
const ErrorNotification = Schema.Struct({
  error: Schema.Struct({ message: Schema.String }),
  willRetry: Schema.Boolean,
})
const McpProgress = Schema.Struct({ message: Schema.String })
const CommandApproval = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  command: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  availableDecisions: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
})
const FileChangeApproval = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  grantRoot: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const UserInputRequest = Schema.Struct({
  autoResolutionMs: Schema.NullOr(Schema.Number),
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      header: Schema.String,
      question: Schema.String,
      isOther: Schema.Boolean,
      isSecret: Schema.Boolean,
      options: Schema.NullOr(
        Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
      ),
    }),
  ),
})
const ServerRequestResolved = Schema.Struct({
  requestId: Schema.Union([Schema.Number, Schema.String]),
})

const approvalDecisions = ["accept", "acceptForSession", "decline", "cancel"] as const
const isApprovalDecision = (value: unknown): value is ApprovalDecision => {
  switch (value) {
    case "accept":
    case "acceptForSession":
    case "decline":
    case "cancel":
      return true
    default:
      return false
  }
}
const availableApprovalDecisions = (value: ReadonlyArray<unknown> | null | undefined) => {
  const available = value?.filter(isApprovalDecision)
  return value === undefined || value === null ? [...approvalDecisions] : (available ?? [])
}

const decode = <A, E>(
  schema: Schema.Codec<A, E, never, never>,
  value: unknown,
  method: string,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () =>
        new CodexProtocolError({
          message: `Codex notification ${method} had an unexpected shape.`,
        }),
    ),
  )

const activityLabel = (item: Schema.Schema.Type<typeof ItemLifecycle>["item"]): string => {
  switch (item.type) {
    case "commandExecution":
      return item.command ? `Running ${item.command}` : "Running a command"
    case "fileChange":
      return "Applying file changes"
    case "mcpToolCall":
      return item.server && item.tool ? `Calling ${item.server}.${item.tool}` : "Calling a tool"
    case "dynamicToolCall":
      return item.tool ? `Calling ${item.tool}` : "Calling a tool"
    case "webSearch":
      return "Searching the web"
    case "reasoning":
      return "Thinking"
    case "collabAgentToolCall":
      return "Coordinating agents"
    default:
      return "Working"
  }
}

export const parseCodexNotification = Effect.fn("CodexAppServer.parseNotification")(
  function* (notification: RpcNotification) {
    const { method, params } = notification

    switch (method) {
      case "thread/started": {
        const value = yield* decode(ThreadStarted, params, method)
        return { _tag: "ThreadStarted", threadId: value.thread.id } satisfies CodexEvent
      }
      case "turn/started": {
        const value = yield* decode(TurnLifecycle, params, method)
        return { _tag: "TurnStarted", turnId: value.turn.id } satisfies CodexEvent
      }
      case "item/agentMessage/delta": {
        const value = yield* decode(AgentMessageDelta, params, method)
        return {
          _tag: "AgentMessageDelta",
          itemId: value.itemId,
          delta: value.delta,
        } satisfies CodexEvent
      }
      case "item/commandExecution/outputDelta": {
        const value = yield* decode(OutputDelta, params, method)
        return { _tag: "CommandOutput", itemId: value.itemId, delta: value.delta } satisfies CodexEvent
      }
      case "item/started": {
        const value = yield* decode(ItemLifecycle, params, method)
        return { _tag: "Activity", label: activityLabel(value.item) } satisfies CodexEvent
      }
      case "item/completed": {
        const value = yield* decode(ItemLifecycle, params, method)
        if (value.item.type === "agentMessage" && value.item.text !== undefined) {
          return {
            _tag: "AgentMessageCompleted",
            itemId: value.item.id,
            text: value.item.text,
          } satisfies CodexEvent
        }
        return { _tag: "Activity", label: activityLabel(value.item) } satisfies CodexEvent
      }
      case "turn/plan/updated": {
        const value = yield* decode(PlanUpdated, params, method)
        return {
          _tag: "PlanUpdated",
          explanation: value.explanation,
          steps: value.plan,
        } satisfies CodexEvent
      }
      case "serverRequest/resolved": {
        const value = yield* decode(ServerRequestResolved, params, method)
        return { _tag: "ServerRequestResolved", requestId: value.requestId } satisfies CodexEvent
      }
      case "thread/tokenUsage/updated": {
        const value = yield* decode(TokenUsage, params, method)
        return {
          _tag: "TokenUsage",
          totalTokens: value.tokenUsage.total.totalTokens,
          lastTokens: value.tokenUsage.last.totalTokens,
          contextWindow: value.tokenUsage.modelContextWindow,
        } satisfies CodexEvent
      }
      case "item/mcpToolCall/progress": {
        const value = yield* decode(McpProgress, params, method)
        return { _tag: "Activity", label: value.message } satisfies CodexEvent
      }
      case "turn/completed": {
        const value = yield* decode(TurnLifecycle, params, method)
        if (value.turn.status === "failed") {
          return {
            _tag: "TurnFailed",
            message: value.turn.error?.message ?? "The Codex turn failed.",
          } satisfies CodexEvent
        }
        return {
          _tag: "TurnCompleted",
          turnId: value.turn.id,
          status: value.turn.status,
        } satisfies CodexEvent
      }
      case "error": {
        const value = yield* decode(ErrorNotification, params, method)
        return value.willRetry
          ? ({ _tag: "Activity", label: value.error.message } satisfies CodexEvent)
          : ({ _tag: "TurnFailed", message: value.error.message } satisfies CodexEvent)
      }
      default:
        return { _tag: "Unknown", method, params } satisfies CodexEvent
    }
  },
)

export const parseCodexServerRequest = Effect.fn("CodexAppServer.parseServerRequest")(
  function* (request: RpcServerRequest) {
    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const params = yield* decode(CommandApproval, request.params, request.method)
        const command = params.command ?? "a command"
        const reason = params.reason ? ` — ${params.reason}` : ""
        return {
          _tag: "ApprovalRequested",
          requestId: request.id,
          kind: "command",
          prompt: `Allow ${command}${reason}?`,
          availableDecisions: availableApprovalDecisions(params.availableDecisions),
          params,
        } satisfies CodexEvent
      }
      case "item/fileChange/requestApproval": {
        const params = yield* decode(FileChangeApproval, request.params, request.method)
        const target = params.grantRoot ? ` under ${params.grantRoot}` : ""
        const reason = params.reason ? ` — ${params.reason}` : ""
        return {
          _tag: "ApprovalRequested",
          requestId: request.id,
          kind: "file-change",
          prompt: `Allow file changes${target}${reason}?`,
          availableDecisions: [...approvalDecisions],
          params,
        } satisfies CodexEvent
      }
      case "item/tool/requestUserInput": {
        const params = yield* decode(UserInputRequest, request.params, request.method)
        return {
          _tag: "UserInputRequested",
          requestId: request.id,
          questions: params.questions,
          autoResolutionMs: params.autoResolutionMs,
        } satisfies CodexEvent
      }
      default:
        return {
          _tag: "Unknown",
          method: request.method,
          params: request.params,
        } satisfies CodexEvent
    }
  },
)
