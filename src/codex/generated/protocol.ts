// Generated protocol snapshot (slimmed to goxt's app-server surface).
// Source: `codex app-server generate-ts --experimental`, codex-cli 0.144.1.
// Keep wire names exactly as emitted by Codex. Unknown notifications remain lossless
// in the event adapter, so adding a server event does not break this client.

export type RequestId = number | string

export interface InitializeParams {
  readonly clientInfo: {
    readonly name: string
    readonly title: string | null
    readonly version: string
  }
  readonly capabilities: {
    readonly experimentalApi: boolean
    readonly requestAttestation: boolean
    readonly mcpServerOpenaiFormElicitation?: boolean
    readonly optOutNotificationMethods?: ReadonlyArray<string> | null
  } | null
}

export interface InitializeResponse {
  readonly userAgent: string
  readonly codexHome: string
  readonly platformFamily: string
  readonly platformOs: string
}

export interface ThreadStartParams {
  readonly cwd?: string | null
  readonly approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never" | null
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null
  readonly experimentalRawEvents?: boolean
}

export interface ThreadResumeParams extends ThreadStartParams {
  readonly threadId: string
  readonly excludeTurns?: boolean
}

export interface ThreadResponse {
  readonly thread: { readonly id: string }
}

export type UserInput =
  | { readonly type: "text"; readonly text: string; readonly text_elements: ReadonlyArray<never> }
  | { readonly type: "image"; readonly url: string; readonly detail?: string }
  | { readonly type: "localImage"; readonly path: string; readonly detail?: string }
  | { readonly type: "skill"; readonly name: string; readonly path: string }
  | { readonly type: "mention"; readonly name: string; readonly path: string }

export interface TurnStartParams {
  readonly threadId: string
  readonly input: ReadonlyArray<UserInput>
  readonly cwd?: string | null
  readonly model?: string | null
  readonly effort?: string | null
}

export interface TurnStartResponse {
  readonly turn: { readonly id: string }
}

export interface TurnSteerParams {
  readonly threadId: string
  readonly input: ReadonlyArray<UserInput>
  readonly expectedTurnId: string
}

export interface TurnSteerResponse {
  readonly turnId: string
}

export interface TurnInterruptParams {
  readonly threadId: string
  readonly turnId: string
}

export type TurnInterruptResponse = Record<string, never>

export interface ReasoningEffortOption {
  readonly reasoningEffort: string
  readonly description: string
}

export interface Model {
  readonly id: string
  readonly model: string
  readonly displayName: string
  readonly description: string
  readonly supportedReasoningEfforts: ReadonlyArray<ReasoningEffortOption>
  readonly defaultReasoningEffort: string
  readonly isDefault: boolean
}

export interface ModelListParams {
  readonly cursor?: string | null
  readonly limit?: number | null
  readonly includeHidden?: boolean | null
}

export interface ModelListResponse {
  readonly data: ReadonlyArray<Model>
  readonly nextCursor: string | null
}

export interface RpcNotification {
  readonly method: string
  readonly params: unknown
}

export interface RpcServerRequest {
  readonly id: RequestId
  readonly method: string
  readonly params: unknown
}

export interface CommandExecutionRequestApprovalParams {
  readonly threadId: string
  readonly turnId: string
  readonly itemId: string
  readonly command?: string | null
  readonly cwd?: string | null
  readonly reason?: string | null
  readonly availableDecisions?: ReadonlyArray<ApprovalDecision> | null
}

export interface FileChangeRequestApprovalParams {
  readonly threadId: string
  readonly turnId: string
  readonly itemId: string
  readonly reason?: string | null
  readonly grantRoot?: string | null
}

export interface ToolRequestUserInputOption {
  readonly label: string
  readonly description: string
}

export interface ToolRequestUserInputQuestion {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly isOther: boolean
  readonly isSecret: boolean
  readonly options: ReadonlyArray<ToolRequestUserInputOption> | null
}

export interface ToolRequestUserInputParams {
  readonly threadId: string
  readonly turnId: string
  readonly itemId: string
  readonly questions: ReadonlyArray<ToolRequestUserInputQuestion>
  readonly autoResolutionMs: number | null
}

export interface ToolRequestUserInputResponse {
  readonly answers: Readonly<Record<string, { readonly answers: ReadonlyArray<string> }>>
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel"

export interface ServerRequestResolvedNotification {
  readonly threadId: string
  readonly requestId: RequestId
}
