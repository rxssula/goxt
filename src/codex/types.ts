import { Schema } from "effect"
import type {
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
  ToolRequestUserInputQuestion,
} from "./generated/protocol.js"

export const CodexStatus = Schema.Struct({
  available: Schema.Boolean,
  authenticated: Schema.Boolean,
  version: Schema.String,
})

export interface CodexStatus extends Schema.Schema.Type<typeof CodexStatus> {}

export const CodexRunRequest = Schema.Struct({
  prompt: Schema.String,
  cwd: Schema.String,
  images: Schema.optionalKey(Schema.Array(Schema.String)),
  sessionId: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

export interface CodexRunRequest extends Schema.Schema.Type<typeof CodexRunRequest> {}

export interface CodexTurnSettings {
  readonly model?: string | null
  readonly reasoningEffort?: string | null
}

export interface CodexImageInput {
  readonly path: string
  readonly label: string
}

export type CodexSessionStatus = "notLoaded" | "idle" | "active" | "waiting" | "systemError"

export interface CodexSession {
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly updatedAt: number
  readonly status: CodexSessionStatus
}

export interface CodexSessionMessage {
  readonly role: "user" | "assistant"
  readonly text: string
}

export interface CodexSessionHistory {
  readonly session: CodexSession
  readonly messages: ReadonlyArray<CodexSessionMessage>
}

export interface CodexModel {
  readonly id: string
  readonly model: string
  readonly displayName: string
  readonly description: string
  readonly supportedReasoningEfforts: ReadonlyArray<{
    readonly reasoningEffort: string
    readonly description: string
  }>
  readonly defaultReasoningEffort: string
  readonly isDefault: boolean
}

export interface CodexRateLimitWindow {
  readonly usedPercent: number
  readonly windowDurationMins: number | null
  readonly resetsAt: number | null
}

export interface CodexRateLimitSnapshot {
  readonly limitId: string | null
  readonly limitName: string | null
  readonly primary: CodexRateLimitWindow | null
  readonly secondary: CodexRateLimitWindow | null
  readonly planType: string | null
}

export interface CodexRateLimits {
  readonly rateLimits: CodexRateLimitSnapshot
  readonly rateLimitsByLimitId: Readonly<Record<string, CodexRateLimitSnapshot>> | null
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel"

export const unsupportedApprovalMessage =
  "No supported approval decision is available in this client."

export type CodexEvent =
  | { readonly _tag: "ThreadStarted"; readonly threadId: string }
  | { readonly _tag: "TurnStarted"; readonly turnId: string }
  | { readonly _tag: "AgentMessageDelta"; readonly itemId: string; readonly delta: string }
  | { readonly _tag: "AgentMessageCompleted"; readonly itemId: string; readonly text: string }
  | { readonly _tag: "CommandOutput"; readonly itemId: string; readonly delta: string }
  | { readonly _tag: "Activity"; readonly label: string }
  | {
      readonly _tag: "PlanUpdated"
      readonly explanation: string | null
      readonly steps: ReadonlyArray<{ readonly step: string; readonly status: string }>
    }
  | {
      readonly _tag: "TokenUsage"
      readonly totalTokens: number
      readonly lastTokens: number
      readonly contextWindow: number | null
    }
  | {
      readonly _tag: "ApprovalRequested"
      readonly requestId: number | string
      readonly kind: "command" | "file-change"
      readonly prompt: string
      readonly availableDecisions: ReadonlyArray<ApprovalDecision>
      readonly params: CommandExecutionRequestApprovalParams | FileChangeRequestApprovalParams
    }
  | {
      readonly _tag: "UserInputRequested"
      readonly requestId: number | string
      readonly questions: ReadonlyArray<ToolRequestUserInputQuestion>
      readonly autoResolutionMs: number | null
    }
  | { readonly _tag: "ServerRequestResolved"; readonly requestId: number | string }
  | { readonly _tag: "TurnCompleted"; readonly turnId: string; readonly status: string }
  | { readonly _tag: "TurnFailed"; readonly message: string }
  | { readonly _tag: "Unknown"; readonly method: string; readonly params: unknown }

export class CodexUnavailable extends Schema.TaggedErrorClass<CodexUnavailable>()(
  "CodexUnavailable",
  { message: Schema.String },
) {}

export class CodexNotAuthenticated extends Schema.TaggedErrorClass<CodexNotAuthenticated>()(
  "CodexNotAuthenticated",
  { message: Schema.String },
) {}

export class CodexProcessError extends Schema.TaggedErrorClass<CodexProcessError>()(
  "CodexProcessError",
  {
    message: Schema.String,
    exitCode: Schema.Number,
  },
) {}

export class CodexProtocolError extends Schema.TaggedErrorClass<CodexProtocolError>()(
  "CodexProtocolError",
  {
    message: Schema.String,
    line: Schema.optionalKey(Schema.String),
  },
) {}

export class CodexRpcError extends Schema.TaggedErrorClass<CodexRpcError>()("CodexRpcError", {
  message: Schema.String,
  code: Schema.Number,
  data: Schema.optionalKey(Schema.Unknown),
}) {}

export type CodexRunError =
  | CodexUnavailable
  | CodexNotAuthenticated
  | CodexProcessError
  | CodexProtocolError
  | CodexRpcError
