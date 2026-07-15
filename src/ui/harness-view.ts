import {
  bold,
  BoxRenderable,
  fg,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  SyntaxStyle,
  t,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core"
import { SpinnerRenderable } from "opentui-spinner"
import type { ToolRequestUserInputResponse } from "../codex/generated/protocol.js"
import type {
  ApprovalDecision,
  CodexEvent,
  CodexModel,
  CodexStatus,
  CodexTurnSettings,
} from "../codex/types.js"
import { theme } from "./theme.js"
import {
  parseSlashCommand,
  slashCommandSuggestions,
  suggestSlashCommands,
  type SlashCommand,
  type SlashCommandSuggestion,
} from "./slash-command.js"

interface Callbacks {
  readonly onSubmit: (prompt: string, settings: CodexTurnSettings) => void
  readonly onSettingsChange?: (settings: CodexTurnSettings) => void
  readonly onSteer: (prompt: string) => void
  readonly onInterrupt: () => void
  readonly onApproval: (requestId: number | string, decision: ApprovalDecision) => void
  readonly onUserInput: (requestId: number | string, response: ToolRequestUserInputResponse) => void
  readonly onQuit: () => void
}

type PendingInteraction =
  | { readonly _tag: "Approval"; readonly requestId: number | string }
  | {
      readonly _tag: "UserInput"
      readonly requestId: number | string
      readonly questionIds: ReadonlyArray<string>
    }

const shortenPath = (path: string, max = 58): string =>
  path.length <= max ? path : `…${path.slice(-(max - 1))}`

const createMarkdownSyntaxStyle = (): SyntaxStyle =>
  SyntaxStyle.fromStyles({
    comment: { fg: theme.subtle, dim: true },
    constant: { fg: "#F9E2AF" },
    "constant.builtin": { fg: "#FAB387" },
    constructor: { fg: "#89DCEB", bold: true },
    function: { fg: "#89DCEB", bold: true },
    "function.builtin": { fg: "#89DCEB" },
    "function.method": { fg: "#74C7EC" },
    keyword: { fg: "#CBA6F7", bold: true },
    "keyword.directive": { fg: "#CBA6F7" },
    label: { fg: "#F9E2AF" },
    number: { fg: "#FAB387" },
    operator: { fg: "#F38BA8" },
    property: { fg: "#89B4FA" },
    "punctuation.bracket": { fg: theme.muted },
    "punctuation.delimiter": { fg: theme.muted },
    "punctuation.special": { fg: theme.muted },
    string: { fg: "#A6E3A1" },
    "string.escape": { fg: "#F2CDCD" },
    type: { fg: "#74C7EC", bold: true },
    variable: { fg: theme.text },
    "variable.builtin": { fg: "#89DCEB" },
    "markup.heading.1": { fg: theme.accent, bold: true },
    "markup.heading.2": { fg: theme.accent, bold: true },
    "markup.heading.3": { fg: theme.accent, bold: true },
    "markup.heading.4": { fg: theme.accent, bold: true },
    "markup.heading.5": { fg: theme.accent, bold: true },
    "markup.heading.6": { fg: theme.accent, bold: true },
    "markup.strong": { fg: theme.text, bold: true },
    "markup.italic": { fg: theme.text, italic: true },
    "markup.strikethrough": { fg: theme.muted },
    "markup.link": { fg: theme.accent, underline: true },
    "markup.link.label": { fg: theme.accent },
    "markup.link.url": { fg: theme.muted, underline: true },
    "markup.list": { fg: theme.accent, bold: true },
    "markup.quote": { fg: theme.muted, italic: true },
    "markup.raw": { fg: theme.accent },
    "markup.raw.block": { fg: theme.text },
  })

export class HarnessView {
  readonly input: InputRenderable

  private readonly renderer: CliRenderer
  private readonly welcome: BoxRenderable
  private readonly transcript: ScrollBoxRenderable
  private readonly status: TextRenderable
  private readonly spinner: SpinnerRenderable
  private readonly settingsStatus: TextRenderable
  private readonly markdownSyntaxStyle: SyntaxStyle
  private readonly onSettingsChange: ((settings: CodexTurnSettings) => void) | undefined
  private readonly slashCommandMenu: BoxRenderable
  private readonly slashCommandRows: ReadonlyArray<TextRenderable>
  private busy = false
  private sessionId: string | undefined
  private models: ReadonlyArray<CodexModel> = []
  private selectedModel: string | null | undefined
  private selectedReasoningEffort: string | null | undefined
  private codexStatus: CodexStatus | undefined
  private pickerOverlay: BoxRenderable | undefined
  private pendingInteraction: PendingInteraction | undefined
  private matchingSlashCommands: ReadonlyArray<SlashCommandSuggestion> = []
  private selectedSlashCommand = 0
  private dismissedSlashCommandValue: string | undefined
  private readonly streamingMessages = new Map<
    string,
    { readonly renderable: MarkdownRenderable; text: string }
  >()

  constructor(
    renderer: CliRenderer,
    cwd: string,
    callbacks: Callbacks,
    initialSettings: CodexTurnSettings = {},
  ) {
    this.renderer = renderer
    this.onSettingsChange = callbacks.onSettingsChange
    this.selectedModel = initialSettings.model
    this.selectedReasoningEffort = initialSettings.reasoningEffort
    this.markdownSyntaxStyle = createMarkdownSyntaxStyle()

    const shell = new BoxRenderable(renderer, {
      id: "shell",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      paddingX: 3,
      paddingY: 1,
      backgroundColor: theme.background,
    })

    const header = new BoxRenderable(renderer, {
      id: "header",
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
    })
    header.add(
      new TextRenderable(renderer, {
        content: t`${bold(fg(theme.text)("goxt"))}`,
        selectable: false,
      }),
    )
    header.add(
      new TextRenderable(renderer, {
        content: t`${fg(theme.subtle)(shortenPath(cwd))}`,
        selectable: false,
      }),
    )

    const main = new BoxRenderable(renderer, {
      id: "main",
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
    })

    this.welcome = new BoxRenderable(renderer, {
      id: "welcome",
      width: 72,
      maxWidth: "92%",
      borderStyle: "single",
      borderColor: theme.border,
      backgroundColor: theme.surface,
      paddingX: 3,
      paddingY: 2,
      flexDirection: "column",
      gap: 1,
    })
    this.welcome.add(
      new TextRenderable(renderer, {
        content: t`${bold(fg(theme.accent)("◇"))}  ${bold(fg(theme.text)("goxt"))} ${fg(theme.muted)("0.1.0")}`,
      }),
    )
    this.welcome.add(
      new TextRenderable(renderer, {
        content: "A quiet terminal harness for Codex.",
        fg: theme.text,
      }),
    )
    this.welcome.add(
      new TextRenderable(renderer, {
        content: "Uses one persistent Codex app-server process and your existing login. Prompts run in this repository with workspace-write access.",
        fg: theme.muted,
      }),
    )
    this.welcome.add(
      new TextRenderable(renderer, {
        content: t`${fg(theme.accent)("Enter")} ${fg(theme.muted)("send / steer")}   ${fg(theme.text)("/help")} ${fg(theme.muted)("commands")}   ${fg(theme.text)("Esc")} ${fg(theme.muted)("interrupt")}   ${fg(theme.text)("Ctrl+C")} ${fg(theme.muted)("quit")}`,
      }),
    )

    this.transcript = new ScrollBoxRenderable(renderer, {
      id: "transcript",
      width: "100%",
      height: "100%",
      visible: false,
      stickyScroll: true,
      stickyStart: "bottom",
      viewportCulling: true,
      contentOptions: {
        flexDirection: "column",
        paddingTop: 1,
        paddingRight: 1,
      },
    })
    this.transcript.verticalScrollBar.visible = false
    this.transcript.horizontalScrollBar.visible = false

    main.add(this.welcome)
    main.add(this.transcript)

    const statusBar = new BoxRenderable(renderer, {
      id: "status-bar",
      width: "100%",
      height: 2,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    })
    const statusGroup = new BoxRenderable(renderer, {
      width: "50%",
      height: 1,
      flexDirection: "row",
      alignItems: "center",
    })
    this.spinner = new SpinnerRenderable(renderer, {
      name: "dots",
      color: theme.accent,
      autoplay: true,
    })
    this.status = new TextRenderable(renderer, {
      id: "status",
      content: "",
      selectable: false,
    })
    this.settingsStatus = new TextRenderable(renderer, {
      id: "settings-status",
      content: "",
      selectable: false,
    })
    statusGroup.add(this.spinner)
    statusGroup.add(this.status)
    statusBar.add(statusGroup)
    statusBar.add(this.settingsStatus)

    this.slashCommandMenu = new BoxRenderable(renderer, {
      id: "slash-command-menu",
      width: 56,
      maxWidth: "100%",
      height: 0,
      marginLeft: 2,
      borderStyle: "rounded",
      borderColor: theme.borderFocused,
      backgroundColor: theme.surface,
      paddingX: 1,
      flexDirection: "column",
      visible: false,
    })
    this.slashCommandRows = slashCommandSuggestions.map(() => {
      const row = new TextRenderable(renderer, {
        height: 1,
        content: "",
        selectable: false,
      })
      this.slashCommandMenu.add(row)
      return row
    })

    const composer = new BoxRenderable(renderer, {
      id: "composer",
      width: "100%",
      height: 3,
      flexDirection: "row",
      alignItems: "center",
      borderStyle: "rounded",
      borderColor: theme.border,
      focusedBorderColor: theme.borderFocused,
      focusable: true,
      paddingX: 1,
      backgroundColor: theme.background,
    })
    composer.add(
      new TextRenderable(renderer, {
        content: t`${fg(theme.accent)("› ")}`,
        selectable: false,
        width: 2,
      }),
    )
    this.input = new InputRenderable(renderer, {
      id: "prompt",
      flexGrow: 1,
      maxLength: 8_000,
      placeholder: "Ask Codex, or type /help…",
      placeholderColor: theme.subtle,
      textColor: theme.text,
      focusedTextColor: theme.text,
      cursorColor: theme.accent,
      backgroundColor: theme.background,
      focusedBackgroundColor: theme.background,
    })
    composer.add(this.input)

    shell.add(header)
    shell.add(main)
    shell.add(statusBar)
    shell.add(this.slashCommandMenu)
    shell.add(composer)
    renderer.root.add(shell)

    this.input.on(InputRenderableEvents.ENTER, (value: string) => {
      if (this.pickerOverlay !== undefined) return
      const prompt = value.trim()
      if (!prompt) return
      this.input.value = ""

      if (this.pendingInteraction?._tag === "Approval") {
        const decision = this.parseApproval(prompt)
        if (decision === undefined) {
          this.input.placeholder = "Type y, session, n, or cancel…"
          return
        }
        const requestId = this.pendingInteraction.requestId
        this.pendingInteraction = undefined
        this.input.placeholder = "Steer the active turn…"
        this.showSpinner()
        callbacks.onApproval(requestId, decision)
        return
      }

      if (this.pendingInteraction?._tag === "UserInput") {
        const interaction = this.pendingInteraction
        const values = prompt.split("|").map((answer) => answer.trim())
        const answers: Record<string, { readonly answers: ReadonlyArray<string> }> = {}
        interaction.questionIds.forEach((id, index) => {
          answers[id] = { answers: [values[index] ?? values[0] ?? ""] }
        })
        this.pendingInteraction = undefined
        this.input.placeholder = "Steer the active turn…"
        this.showSpinner()
        callbacks.onUserInput(interaction.requestId, { answers })
        return
      }

      const command = parseSlashCommand(prompt)
      if (command !== undefined) {
        this.handleSlashCommand(command)
        return
      }

      if (this.busy) {
        this.addMessage("you · steer", prompt, theme.user)
        this.showSpinner()
        callbacks.onSteer(prompt)
        return
      }
      callbacks.onSubmit(prompt, this.turnSettings())
    })

    this.input.on(InputRenderableEvents.INPUT, (value: string) => {
      if (value !== this.dismissedSlashCommandValue) this.dismissedSlashCommandValue = undefined
      this.updateSlashCommandMenu(value)
    })

    renderer.keyInput.on("keypress", (key) => {
      if (key.ctrl && key.name === "c") {
        callbacks.onQuit()
        return
      }
      if (key.name === "escape" && this.pickerOverlay !== undefined) {
        this.closePicker()
        return
      }
      if (this.handleSlashCommandCompletionKey(key)) return
      if (key.name === "escape" && this.busy) callbacks.onInterrupt()
    })

    this.input.focus()
  }

  get currentSessionId(): string | undefined {
    return this.sessionId
  }

  setCodexStatus(codex: CodexStatus): void {
    this.codexStatus = codex
    if (!codex.available) {
      this.settingsStatus.content = ""
      this.setStatus(t`${fg(theme.error)("● Codex CLI not found")}`)
      return
    }
    if (!codex.authenticated) {
      this.settingsStatus.content = ""
      this.setStatus(t`${fg(theme.error)("● Codex login required")}`)
      return
    }
    this.setStatus(t`${fg(theme.accent)("● ready")}`)
    this.updateSettingsStatus()
  }

  setModels(models: ReadonlyArray<CodexModel>): void {
    this.models = models
    let settingsChanged = false

    if (typeof this.selectedModel === "string") {
      const model = models.find(
        (candidate) =>
          candidate.model === this.selectedModel || candidate.id === this.selectedModel,
      )
      if (model === undefined) {
        this.selectedModel = undefined
        settingsChanged = true
      } else if (this.selectedModel !== model.model) {
        this.selectedModel = model.model
        settingsChanged = true
      }
    }

    const activeModel = this.activeModel()
    if (
      activeModel !== undefined &&
      typeof this.selectedReasoningEffort === "string" &&
      !activeModel.supportedReasoningEfforts.some(
        (option) => option.reasoningEffort === this.selectedReasoningEffort,
      )
    ) {
      this.selectedReasoningEffort = activeModel.defaultReasoningEffort
      settingsChanged = true
    }

    if (settingsChanged) this.persistSettings()
    this.updateSettingsStatus()
  }

  begin(prompt: string): void {
    this.busy = true
    this.hideSlashCommandMenu()
    this.welcome.visible = false
    this.transcript.visible = true
    this.addMessage("you", prompt, theme.user)
    this.showSpinner()
    this.input.placeholder = "Steer the active turn…"
    this.input.focus()
  }

  handleEvent(event: CodexEvent): void {
    switch (event._tag) {
      case "ThreadStarted":
        this.sessionId = event.threadId
        break
      case "TurnStarted":
        this.streamingMessages.clear()
        break
      case "AgentMessageDelta": {
        let message = this.streamingMessages.get(event.itemId)
        if (message === undefined) {
          message = { renderable: this.addMarkdownMessage("codex", "", theme.accent), text: "" }
          this.streamingMessages.set(event.itemId, message)
        }
        message.text += event.delta
        message.renderable.content = message.text
        this.transcript.scrollTo(Number.MAX_SAFE_INTEGER)
        break
      }
      case "AgentMessageCompleted": {
        const message = this.streamingMessages.get(event.itemId)
        if (message === undefined) {
          const body = this.addMarkdownMessage("codex", event.text, theme.accent)
          body.streaming = false
        }
        else {
          message.renderable.content = event.text
          message.renderable.streaming = false
          this.streamingMessages.delete(event.itemId)
        }
        break
      }
      case "CommandOutput":
        break
      case "Activity":
        this.showSpinner()
        break
      case "PlanUpdated": {
        const plan = event.steps
          .map((step) => `${step.status === "completed" ? "✓" : step.status === "inProgress" ? "→" : "·"} ${step.step}`)
          .join("\n")
        this.addMessage("plan", plan, theme.muted)
        break
      }
      case "TokenUsage":
        break
      case "ApprovalRequested":
        this.pendingInteraction = { _tag: "Approval", requestId: event.requestId }
        this.hideSlashCommandMenu()
        this.addMessage("approval", event.prompt, theme.accent)
        this.setStatus(t`${fg(theme.accent)("● approval needed")}`)
        this.input.placeholder = "Type y, session, n, or cancel…"
        this.input.focus()
        break
      case "UserInputRequested": {
        this.pendingInteraction = {
          _tag: "UserInput",
          requestId: event.requestId,
          questionIds: event.questions.map((question) => question.id),
        }
        this.hideSlashCommandMenu()
        const content = event.questions
          .map((question) => {
            const options = question.options?.map((option) => option.label).join(" / ")
            return options ? `${question.question}\n${options}` : question.question
        })
          .join("\n\n")
        this.addMessage("codex · question", content, theme.accent)
        this.setStatus(t`${fg(theme.accent)("● input needed")}`)
        this.input.placeholder =
          event.questions.length > 1 ? "Answer each question separated by | …" : "Type your answer…"
        this.input.focus()
        break
      }
      case "TurnFailed":
        this.setStatus(t`${fg(theme.error)("●")} ${fg(theme.error)(event.message)}`)
        break
      case "TurnCompleted":
      case "Unknown":
        break
    }
  }

  complete(): void {
    this.busy = false
    this.pendingInteraction = undefined
    this.setStatus(t`${fg(theme.accent)("● ready")}`)
    this.input.placeholder = "Continue the session, or type /help…"
    this.input.focus()
  }

  interrupted(): void {
    this.busy = false
    this.pendingInteraction = undefined
    this.setStatus(t`${fg(theme.muted)("○ interrupted")}`)
    this.input.placeholder = "Continue the session, or type /help…"
    this.input.focus()
  }

  interrupting(): void {
    this.showSpinner()
    this.input.placeholder = "Waiting for the turn to stop…"
    this.input.blur()
  }

  actionFailed(message: string): void {
    this.addMessage("error", message, theme.error)
    this.showSpinner()
    this.input.placeholder = "Steer the active turn…"
    this.input.focus()
  }

  fail(message: string): void {
    this.busy = false
    this.addMessage("error", message, theme.error)
    this.setStatus(t`${fg(theme.error)("● failed")} ${fg(theme.muted)("· check the message above")}`)
    this.input.placeholder = "Try another prompt, or type /help…"
    this.input.focus()
  }

  destroy(): void {
    this.markdownSyntaxStyle.destroy()
    this.renderer.destroy()
  }

  private turnSettings(): CodexTurnSettings {
    return {
      ...(this.selectedModel === undefined ? {} : { model: this.selectedModel }),
      ...(this.selectedReasoningEffort === undefined
        ? {}
        : { reasoningEffort: this.selectedReasoningEffort }),
    }
  }

  private persistSettings(): void {
    this.onSettingsChange?.(this.turnSettings())
  }

  private handleSlashCommandCompletionKey(key: KeyEvent): boolean {
    if (this.matchingSlashCommands.length === 0 || this.pickerOverlay !== undefined) return false

    if (key.name === "up" || key.name === "down") {
      const direction = key.name === "up" ? -1 : 1
      this.selectedSlashCommand =
        (this.selectedSlashCommand + direction + this.matchingSlashCommands.length) %
        this.matchingSlashCommands.length
      this.renderSlashCommandMenu()
      key.preventDefault()
      return true
    }

    if (key.name === "tab") {
      const command = this.matchingSlashCommands[this.selectedSlashCommand]
      if (command !== undefined) this.input.value = `/${command.name} `
      key.preventDefault()
      return true
    }

    if (key.name === "return" || key.name === "kpenter" || key.name === "linefeed") {
      const command = this.matchingSlashCommands[this.selectedSlashCommand]
      const completion = command === undefined ? undefined : `/${command.name}`
      if (completion !== undefined && completion !== this.input.value.toLowerCase()) {
        this.input.value = completion
        key.preventDefault()
        return true
      }
    }

    if (key.name === "escape") {
      this.dismissedSlashCommandValue = this.input.value
      this.hideSlashCommandMenu()
      key.preventDefault()
      return true
    }

    return false
  }

  private updateSlashCommandMenu(value: string): void {
    if (
      this.busy ||
      this.pendingInteraction !== undefined ||
      this.pickerOverlay !== undefined ||
      value === this.dismissedSlashCommandValue
    ) {
      this.hideSlashCommandMenu()
      return
    }

    this.matchingSlashCommands = suggestSlashCommands(value)
    this.selectedSlashCommand = 0
    if (this.matchingSlashCommands.length === 0) {
      this.hideSlashCommandMenu()
      return
    }
    this.renderSlashCommandMenu()
  }

  private renderSlashCommandMenu(): void {
    this.slashCommandMenu.visible = true
    this.slashCommandMenu.height = this.matchingSlashCommands.length + 2
    this.slashCommandRows.forEach((row, index) => {
      const command = this.matchingSlashCommands[index]
      row.visible = command !== undefined
      if (command === undefined) return
      const selected = index === this.selectedSlashCommand
      row.content = t`${fg(selected ? theme.accent : theme.subtle)(selected ? "›" : " ")} ${fg(
        selected ? theme.text : theme.muted,
      )(`/${command.name}`)} ${fg(theme.subtle)(command.description)}`
    })
  }

  private hideSlashCommandMenu(): void {
    this.matchingSlashCommands = []
    this.slashCommandMenu.visible = false
    this.slashCommandMenu.height = 0
  }

  private handleSlashCommand(command: SlashCommand): void {
    if (this.busy) {
      this.showCommandMessage("command", "Slash commands can only run between turns.", true)
      return
    }

    switch (command._tag) {
      case "Clear":
        this.clearSession()
        return
      case "Help":
        this.showCommandMessage(
          "commands",
          "/clear                 start a new session and clear the screen\n/model                 open model picker\n/model <id>            switch model directly\n/model default         use the catalog default\n/reasoning             open reasoning picker\n/reasoning <level>     switch reasoning directly\n/reasoning default     use the model default",
        )
        return
      case "Unknown":
        this.showCommandMessage(
          "command",
          `Unknown command /${command.name}. Type /help for available commands.`,
          true,
        )
        return
      case "Model":
        this.handleModelCommand(command.value)
        return
      case "Reasoning":
        this.handleReasoningCommand(command.value)
        return
    }
  }

  private clearSession(): void {
    this.sessionId = undefined
    this.pendingInteraction = undefined
    this.streamingMessages.clear()
    for (const child of this.transcript.getChildren()) {
      this.transcript.remove(child)
      child.destroyRecursively()
    }
    this.transcript.scrollTo(0)
    this.transcript.visible = false
    this.welcome.visible = true
    this.input.value = ""
    this.input.placeholder = "Ask Codex, or type /help…"
    this.dismissedSlashCommandValue = undefined
    this.hideSlashCommandMenu()
    if (this.codexStatus?.available === true && this.codexStatus.authenticated) {
      this.setStatus(t`${fg(theme.accent)("● ready")}`)
      this.updateSettingsStatus()
    }
    this.input.focus()
  }

  private handleModelCommand(value: string | undefined): void {
    if (value === undefined) {
      if (this.models.length === 0) {
        this.showCommandMessage("models", "The Codex model catalog is not available yet.", true)
        return
      }
      this.openModelPicker()
      return
    }

    if (value.toLowerCase() === "default") {
      const model = this.models.find((candidate) => candidate.isDefault) ?? this.models[0]
      if (model === undefined) {
        this.showCommandMessage("model", "The Codex model catalog is not available yet.", true)
        return
      }
      this.selectModel(model, true)
      return
    }

    const normalized = value.toLowerCase()
    const model = this.models.find(
      (candidate) =>
        candidate.id.toLowerCase() === normalized || candidate.model.toLowerCase() === normalized,
    )
    if (model === undefined) {
      this.showCommandMessage(
        "model",
        `Unknown model ${value}. Type /model to see available models.`,
        true,
      )
      return
    }

    this.selectModel(model)
  }

  private handleReasoningCommand(value: string | undefined): void {
    const model = this.activeModel()
    if (model === undefined) {
      this.showCommandMessage(
        "reasoning",
        "Select a model first, or wait for the Codex model catalog to load.",
        true,
      )
      return
    }

    if (value === undefined) {
      this.openReasoningPicker(model)
      return
    }

    if (value.toLowerCase() === "default") {
      this.selectedReasoningEffort = model.defaultReasoningEffort
      this.showCommandMessage(
        "reasoning",
        `Using ${model.defaultReasoningEffort}, the default for ${model.displayName}.`,
      )
      this.updateSettingsStatus()
      this.persistSettings()
      return
    }

    const normalized = value.toLowerCase()
    const effort = model.supportedReasoningEfforts.find(
      (option) => option.reasoningEffort.toLowerCase() === normalized,
    )
    if (effort === undefined) {
      this.showCommandMessage(
        "reasoning",
        `${value} is not supported by ${model.displayName}. Type /reasoning to see available levels.`,
        true,
      )
      return
    }

    this.selectedReasoningEffort = effort.reasoningEffort
    this.showCommandMessage(
      "reasoning",
      `Switched to ${effort.reasoningEffort} reasoning for future turns.`,
    )
    this.updateSettingsStatus()
    this.persistSettings()
  }

  private openModelPicker(): void {
    const active = this.activeModel()
    const selectedIndex = Math.max(
      0,
      this.models.findIndex((model) => model.model === active?.model),
    )
    const options = this.models.map((model) => ({
      name: `${model.displayName}  ${model.model}`,
      description: model.description,
    }))
    this.openPicker(
      "Choose model",
      "Applies to the next turn and remains active for this session.",
      options,
      selectedIndex,
      (index) => {
        const model = this.models[index]
        if (model !== undefined) this.selectModel(model)
      },
    )
  }

  private openReasoningPicker(model: CodexModel): void {
    const active = this.activeReasoningEffort(model)
    const selectedIndex = Math.max(
      0,
      model.supportedReasoningEfforts.findIndex(
        (option) => option.reasoningEffort === active,
      ),
    )
    const options = model.supportedReasoningEfforts.map((option) => ({
      name: option.reasoningEffort,
      description: option.description,
    }))
    this.openPicker(
      "Choose reasoning level",
      `${model.displayName} · applies to future turns`,
      options,
      selectedIndex,
      (index) => {
        const effort = model.supportedReasoningEfforts[index]
        if (effort !== undefined) this.selectReasoningEffort(effort.reasoningEffort)
      },
    )
  }

  private openPicker(
    title: string,
    subtitle: string,
    options: ReadonlyArray<SelectOption>,
    selectedIndex: number,
    onSelect: (index: number) => void,
  ): void {
    this.closePicker(false)

    const overlay = new BoxRenderable(this.renderer, {
      id: "picker-overlay",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 100,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: theme.background,
    })
    const dialogHeight = Math.min(options.length * 2 + 10, 26)
    const dialog = new BoxRenderable(this.renderer, {
      id: "picker-dialog",
      width: 66,
      maxWidth: "90%",
      height: dialogHeight,
      maxHeight: "85%",
      borderStyle: "rounded",
      borderColor: theme.borderFocused,
      backgroundColor: theme.surface,
      paddingX: 2,
      paddingY: 1,
      flexDirection: "column",
      gap: 1,
    })
    dialog.add(
      new TextRenderable(this.renderer, {
        content: t`${bold(fg(theme.text)(title))}`,
        height: 1,
        selectable: false,
      }),
    )
    dialog.add(
      new TextRenderable(this.renderer, {
        content: subtitle,
        fg: theme.muted,
        height: 1,
        selectable: false,
      }),
    )
    const select = new SelectRenderable(this.renderer, {
      id: "picker-select",
      width: "100%",
      flexGrow: 1,
      options: [...options],
      selectedIndex,
      backgroundColor: theme.surface,
      focusedBackgroundColor: theme.surface,
      textColor: theme.text,
      focusedTextColor: theme.text,
      selectedBackgroundColor: theme.border,
      selectedTextColor: theme.accent,
      descriptionColor: theme.muted,
      selectedDescriptionColor: theme.text,
      showDescription: true,
      showScrollIndicator: false,
      wrapSelection: true,
    })
    select.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
      this.closePicker()
      onSelect(index)
    })
    dialog.add(select)
    dialog.add(
      new TextRenderable(this.renderer, {
        content: "↑↓ navigate   Enter select   Esc cancel",
        fg: theme.subtle,
        height: 1,
        selectable: false,
      }),
    )
    overlay.add(dialog)
    this.renderer.root.add(overlay)
    this.pickerOverlay = overlay
    this.input.blur()
    select.focus()
  }

  private closePicker(focusInput = true): void {
    const overlay = this.pickerOverlay
    if (overlay === undefined) return
    this.pickerOverlay = undefined
    overlay.parent?.remove(overlay)
    overlay.destroyRecursively()
    if (focusInput) this.input.focus()
  }

  private selectModel(model: CodexModel, catalogDefault = false): void {
    let resetReasoning = false
    if (
      typeof this.selectedReasoningEffort === "string" &&
      !model.supportedReasoningEfforts.some(
        (option) => option.reasoningEffort === this.selectedReasoningEffort,
      )
    ) {
      this.selectedReasoningEffort = model.defaultReasoningEffort
      resetReasoning = true
    }
    this.selectedModel = model.model
    this.showCommandMessage(
      "model",
      `${catalogDefault ? "Using" : "Switched to"} ${model.displayName} (${model.model})${
        catalogDefault ? ", the catalog default," : ""
      } for future turns.${resetReasoning ? "\nReasoning was reset to the model default." : ""}`,
    )
    this.updateSettingsStatus()
    this.persistSettings()
  }

  private selectReasoningEffort(effort: string): void {
    this.selectedReasoningEffort = effort
    this.showCommandMessage("reasoning", `Switched to ${effort} reasoning for future turns.`)
    this.updateSettingsStatus()
    this.persistSettings()
  }

  private activeModel(): CodexModel | undefined {
    if (typeof this.selectedModel === "string") {
      return this.models.find((model) => model.model === this.selectedModel)
    }
    return this.models.find((model) => model.isDefault) ?? this.models[0]
  }

  private activeReasoningEffort(model: CodexModel): string {
    return typeof this.selectedReasoningEffort === "string"
      ? this.selectedReasoningEffort
      : model.defaultReasoningEffort
  }

  private updateSettingsStatus(): void {
    if (this.codexStatus?.available !== true || !this.codexStatus.authenticated) return
    const model = this.activeModel()
    const modelLabel = model?.model ?? "default model"
    const effortLabel = model === undefined ? "default reasoning" : this.activeReasoningEffort(model)
    this.settingsStatus.content = t`${fg(theme.subtle)(`${modelLabel} · ${effortLabel}`)}`
  }

  private showSpinner(): void {
    this.status.content = ""
    this.spinner.visible = true
  }

  private setStatus(content: TextRenderable["content"]): void {
    this.spinner.visible = false
    this.status.content = content
  }

  private showCommandMessage(label: string, content: string, error = false): void {
    this.welcome.visible = false
    this.transcript.visible = true
    this.addMessage(label, content, error ? theme.error : theme.accent)
    this.input.placeholder = "Ask Codex, or type /help…"
    this.input.focus()
  }

  private parseApproval(value: string): ApprovalDecision | undefined {
    switch (value.toLowerCase()) {
      case "y":
      case "yes":
      case "accept":
        return "accept"
      case "session":
      case "always":
        return "acceptForSession"
      case "n":
      case "no":
      case "decline":
        return "decline"
      case "cancel":
        return "cancel"
      default:
        return undefined
    }
  }

  private addMessage(label: string, content: string, color: string): TextRenderable {
    const message = new BoxRenderable(this.renderer, {
      width: "100%",
      flexDirection: "column",
      marginBottom: 1,
    })
    message.add(
      new TextRenderable(this.renderer, {
        content: t`${bold(fg(color)(label))}`,
        height: 1,
      }),
    )
    const body = new TextRenderable(this.renderer, {
      content,
      fg: label === "error" ? theme.error : theme.text,
      width: "100%",
    })
    message.add(body)
    this.transcript.add(message)
    this.transcript.scrollTo(Number.MAX_SAFE_INTEGER)
    return body
  }

  private addMarkdownMessage(
    label: string,
    content: string,
    color: string,
  ): MarkdownRenderable {
    const message = new BoxRenderable(this.renderer, {
      width: "100%",
      flexDirection: "column",
      marginBottom: 1,
    })
    message.add(
      new TextRenderable(this.renderer, {
        content: t`${bold(fg(color)(label))}`,
        height: 1,
      }),
    )
    const body = new MarkdownRenderable(this.renderer, {
      content,
      syntaxStyle: this.markdownSyntaxStyle,
      fg: label === "error" ? theme.error : theme.text,
      width: "100%",
      conceal: true,
      concealCode: true,
      streaming: true,
      internalBlockMode: "coalesced",
    })
    message.add(body)
    this.transcript.add(message)
    this.transcript.scrollTo(Number.MAX_SAFE_INTEGER)
    return body
  }
}
