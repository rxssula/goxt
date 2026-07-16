import {
  bold,
  BoxRenderable,
  fg,
  MarkdownRenderable,
  type PasteEvent,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  SyntaxStyle,
  t,
  TextRenderable,
  TextareaRenderable,
  type CliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SpinnerRenderable } from "opentui-spinner"
import type { ToolRequestUserInputResponse } from "../codex/generated/protocol.js"
import {
  unsupportedApprovalMessage,
  type ApprovalDecision,
  type CodexEvent,
  type CodexImageInput,
  type CodexModel,
  type CodexRateLimits,
  type CodexSession,
  type CodexSessionHistory,
  type CodexStatus,
  type CodexTurnSettings,
} from "../codex/types.js"
import {
  decodeImage,
  detectImageFormat,
  encodeImageAsPng,
  readMacClipboardImage,
  resizeImage,
} from "./image-codec.js"
import { theme } from "./theme.js"
import {
  parseSlashCommand,
  slashCommandSuggestions,
  suggestSlashCommands,
  type SlashCommand,
  type SlashCommandSuggestion,
} from "./slash-command.js"

class PromptTextarea extends TextareaRenderable {
  private _maxLength = 8_000
  onValueChange: ((value: string) => void) | undefined
  onImagePaste: ((event: PasteEvent) => void) | undefined

  get value(): string {
    return this.plainText
  }

  set value(value: string) {
    this.setText(value.slice(0, this._maxLength))
    this.onValueChange?.(this.plainText)
  }

  get maxLength(): number {
    return this._maxLength
  }

  set maxLength(value: number) {
    this._maxLength = value
    if (this.plainText.length > value) this.setText(this.plainText.slice(0, value))
  }

  override insertText(text: string): void {
    const available = this._maxLength - this.plainText.length
    if (available > 0) super.insertText(text.slice(0, available))
  }


  override handlePaste(event: PasteEvent): void {
    if (
      event.bytes.length === 0 ||
      event.metadata?.mimeType?.startsWith("image/") ||
      event.metadata?.kind === "binary"
    ) {
      this.onImagePaste?.(event)
      return
    }
    super.handlePaste(event)
  }
}

interface Callbacks {
  readonly onSubmit: (
    prompt: string,
    settings: CodexTurnSettings,
    images: ReadonlyArray<CodexImageInput>,
  ) => void
  readonly onSettingsChange?: (settings: CodexTurnSettings) => void
  readonly onSteer: (prompt: string, images: ReadonlyArray<CodexImageInput>) => void
  readonly onInterrupt: () => void
  readonly onApproval: (
    requestId: number | string,
    decision: ApprovalDecision,
  ) => void | Promise<void>
  readonly onUserInput: (
    requestId: number | string,
    response: ToolRequestUserInputResponse,
  ) => void | Promise<void>
  readonly onUsage?: () => void
  readonly onSessions?: () => void
  readonly onSessionSelect?: (sessionId: string) => void
  readonly onQuit: () => void
  readonly writeTerminal?: (sequence: string) => void
}

type PendingInteraction =
  | {
      readonly _tag: "Approval"
      readonly requestId: number | string
      readonly availableDecisions: ReadonlyArray<ApprovalDecision>
      responding: boolean
      expired: boolean
    }
  | {
      readonly _tag: "UserInput"
      readonly requestId: number | string
      readonly questionIds: ReadonlyArray<string>
      readonly isSecret: boolean
      responding: boolean
      expired: boolean
    }

const shortenPath = (path: string, max = 58): string =>
  path.length <= max ? path : `…${path.slice(-(max - 1))}`

const formatMessageTime = (date = new Date()): string =>
  date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

const formatElapsed = (milliseconds: number): string => {
  const seconds = Math.max(0, milliseconds) / 1_000
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`
}

const formatTokens = (tokens: number): string =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(tokens)

const formatPercent = (percent: number): string => `${percent.toFixed(percent >= 10 ? 0 : 1)}%`

const formatWindowDuration = (minutes: number): string => {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

const formatReset = (resetsAt: number | null): string =>
  resetsAt === null ? "reset time unavailable" : `resets ${new Date(resetsAt * 1_000).toLocaleString()}`

type TokenUsageDetails = {
  readonly totalTokens: number
  readonly lastTokens: number
  readonly contextWindow: number | null
}

export const formatCodexUsage = (
  rateLimits: CodexRateLimits,
  tokenUsage: TokenUsageDetails | undefined,
): string => {
  const snapshots = Object.values(rateLimits.rateLimitsByLimitId ?? {})
  const limits = snapshots.length > 0 ? snapshots : [rateLimits.rateLimits]
  const lines = ["Account limits"]

  for (const snapshot of limits) {
    const name = snapshot.limitName ?? snapshot.limitId ?? "Codex"
    lines.push(`  ${name}${snapshot.planType ? ` · ${snapshot.planType}` : ""}`)
    for (const [label, window] of [
      ["Primary", snapshot.primary],
      ["Secondary", snapshot.secondary],
    ] as const) {
      if (window === null) continue
      const duration =
        window.windowDurationMins === null
          ? "window"
          : `${formatWindowDuration(window.windowDurationMins)} window`
      lines.push(
        `    ${label}: ${formatPercent(window.usedPercent)} used · ${duration} · ${formatReset(window.resetsAt)}`,
      )
    }
  }

  lines.push("", "Context window")
  if (tokenUsage === undefined) {
    lines.push("  No token usage reported yet. Run a turn to see context details.")
  } else {
    lines.push(`  Latest turn: ${formatTokens(tokenUsage.lastTokens)} tokens`)
    lines.push(`  Thread total: ${formatTokens(tokenUsage.totalTokens)} tokens`)
    if (tokenUsage.contextWindow === null) {
      lines.push("  Capacity: unavailable")
    } else {
      lines.push(`  Capacity: ${formatTokens(tokenUsage.contextWindow)} tokens`)
      lines.push(
        `  Latest turn utilization: ${formatPercent((tokenUsage.lastTokens / tokenUsage.contextWindow) * 100)}`,
      )
    }
  }

  return lines.join("\n")
}

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
  readonly input: PromptTextarea

  private readonly renderer: CliRenderer
  private readonly welcome: BoxRenderable
  private readonly transcript: ScrollBoxRenderable
  private readonly status: TextRenderable
  private readonly spinner: SpinnerRenderable
  private readonly settingsStatus: TextRenderable
  private readonly shell: BoxRenderable
  private readonly headerPath: TextRenderable
  private readonly statusGroup: BoxRenderable
  private readonly markdownSyntaxStyle: SyntaxStyle
  private readonly onSettingsChange: ((settings: CodexTurnSettings) => void) | undefined
  private readonly onUsage: (() => void) | undefined
  private readonly onSessions: (() => void) | undefined
  private readonly onSessionSelect: ((sessionId: string) => void) | undefined
  private sessions: ReadonlyArray<CodexSession> = []
  private readonly onUserInput: Callbacks["onUserInput"]
  private readonly slashCommandMenu: BoxRenderable
  private readonly slashCommandRows: ReadonlyArray<TextRenderable>
  private readonly composer: BoxRenderable
  private readonly imagePreview: BoxRenderable
  private readonly imagePreviewBitmap: TextRenderable
  private readonly attachments = new Map<string, CodexImageInput>()
  private nextImageNumber = 1
  private readonly writeTerminal: ((sequence: string) => void) | undefined
  private readonly kittyImageId = 0x676f78
  private busy = false
  private sessionId: string | undefined
  private models: ReadonlyArray<CodexModel> = []
  private selectedModel: string | null | undefined
  private selectedReasoningEffort: string | null | undefined
  private codexStatus: CodexStatus | undefined
  private pickerOverlay: BoxRenderable | undefined
  private pickerSelect: SelectRenderable | undefined
  private readonly pendingInteractions = new Map<number | string, PendingInteraction>()
  private readonly interactionTimers = new Map<number | string, ReturnType<typeof setTimeout>>()
  private planBody: TextRenderable | undefined
  private matchingSlashCommands: ReadonlyArray<SlashCommandSuggestion> = []
  private selectedSlashCommand = 0
  private dismissedSlashCommandValue: string | undefined
  private latestTokenUsage: TokenUsageDetails | undefined
  private turnStartedAt: number | undefined
  private thoughtRecorded = false
  private workedRecorded = false
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
    this.onUsage = callbacks.onUsage
    this.onSessions = callbacks.onSessions
    this.onSessionSelect = callbacks.onSessionSelect
    this.onUserInput = callbacks.onUserInput
    this.writeTerminal = callbacks.writeTerminal
    this.selectedModel = initialSettings.model
    this.selectedReasoningEffort = initialSettings.reasoningEffort
    this.markdownSyntaxStyle = createMarkdownSyntaxStyle()

    this.shell = new BoxRenderable(renderer, {
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
    this.headerPath = new TextRenderable(renderer, {
      content: t`${fg(theme.subtle)(shortenPath(cwd))}`,
      selectable: false,
    })
    header.add(this.headerPath)

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
        paddingTop: 2,
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
      height: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    })
    this.statusGroup = new BoxRenderable(renderer, {
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
    this.statusGroup.add(this.spinner)
    this.statusGroup.add(this.status)
    statusBar.add(this.statusGroup)
    statusBar.add(this.settingsStatus)

    this.slashCommandMenu = new BoxRenderable(renderer, {
      id: "slash-command-menu",
      position: "absolute",
      bottom: 4,
      left: 3,
      zIndex: 50,
      width: 56,
      maxWidth: "100%",
      height: 0,
      borderStyle: "rounded",
      borderColor: theme.borderFocused,
      backgroundColor: theme.background,
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

    this.imagePreview = new BoxRenderable(renderer, {
      id: "image-preview",
      position: "absolute",
      bottom: 4,
      left: "15%",
      zIndex: 40,
      width: "70%",
      height: 16,
      borderStyle: "rounded",
      borderColor: theme.borderFocused,
      backgroundColor: theme.background,
      padding: 1,
      visible: false,
    })
    this.imagePreviewBitmap = new TextRenderable(renderer, {
      id: "image-preview-bitmap",
      width: "100%",
      height: "100%",
      selectable: false,
    })
    this.imagePreview.add(this.imagePreviewBitmap)

    this.composer = new BoxRenderable(renderer, {
      id: "composer",
      width: "100%",
      height: 3,
      flexShrink: 0,
      flexDirection: "row",
      alignItems: "flex-start",
      borderStyle: "rounded",
      borderColor: theme.border,
      focusedBorderColor: theme.borderFocused,
      focusable: true,
      paddingX: 1,
      backgroundColor: theme.background,
    })
    this.composer.add(
      new TextRenderable(renderer, {
        content: t`${fg(theme.accent)("› ")}`,
        selectable: false,
        width: 2,
      }),
    )
    this.input = new PromptTextarea(renderer, {
      id: "prompt",
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: 0,
      height: 1,
      wrapMode: "char",
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        { name: "linefeed", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "kpenter", shift: true, action: "newline" },
      ],
      placeholder: "Ask Codex, or type /help…",
      placeholderColor: theme.subtle,
      textColor: theme.text,
      focusedTextColor: theme.text,
      cursorColor: theme.accent,
      backgroundColor: theme.background,
      focusedBackgroundColor: theme.background,
    })
    this.composer.add(this.input)

    this.shell.add(header)
    this.shell.add(main)
    this.shell.add(statusBar)
    this.shell.add(this.slashCommandMenu)
    this.shell.add(this.imagePreview)
    this.shell.add(this.composer)
    renderer.root.add(this.shell)
    this.applyResponsiveLayout(renderer.width, renderer.height)
    renderer.on("resize", (width, height) => {
      this.applyResponsiveLayout(width, height)
      queueMicrotask(() => this.updateComposerHeight())
    })

    this.input.onSubmit = () => {
      if (this.pickerOverlay !== undefined) return
      const value = this.input.value
      const suggestion = this.matchingSlashCommands[this.selectedSlashCommand]
      const completion = suggestion === undefined ? undefined : `/${suggestion.name}`
      if (completion !== undefined && completion !== value.toLowerCase()) {
        this.input.value = completion
        return
      }
      const prompt = value.trim()
      if (!prompt) return
      const images = this.activeAttachments(value)
      this.input.value = ""
      this.attachments.clear()
      this.hideImagePreview()
      this.updateComposerHeight()

      const pendingInteraction = this.activeInteraction()
      if (pendingInteraction?._tag === "Approval") {
        const decision = this.parseApproval(prompt, pendingInteraction.availableDecisions)
        if (decision === undefined) {
          this.activateNextInteraction()
          return
        }
        const requestId = pendingInteraction.requestId
        pendingInteraction.responding = true
        this.input.placeholder = "Sending approval…"
        this.input.blur()
        this.showSpinner()
        void Promise.resolve(callbacks.onApproval(requestId, decision)).then(
          () => this.resolveInteraction(requestId),
          () => this.restoreInteraction(requestId),
        )
        return
      }

      if (pendingInteraction?._tag === "UserInput") {
        const interaction = pendingInteraction
        const values = prompt.split("|").map((answer) => answer.trim())
        const answers: Record<string, { readonly answers: ReadonlyArray<string> }> = {}
        interaction.questionIds.forEach((id, index) => {
          answers[id] = { answers: [values[index] ?? ""] }
        })
        interaction.responding = true
        this.input.placeholder = "Sending answer…"
        this.input.blur()
        this.showSpinner()
        void Promise.resolve(callbacks.onUserInput(interaction.requestId, { answers })).then(
          () => this.resolveInteraction(interaction.requestId),
          () => this.restoreInteraction(interaction.requestId),
        )
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
        callbacks.onSteer(prompt, images)
        return
      }
      callbacks.onSubmit(prompt, this.turnSettings(), images)
    }

    const inputChanged = (value: string) => {
      if (value !== this.dismissedSlashCommandValue) this.dismissedSlashCommandValue = undefined
      this.updateSlashCommandMenu(value)
      queueMicrotask(() => this.updateComposerHeight())
    }
    this.input.onValueChange = inputChanged
    this.input.onContentChange = () => inputChanged(this.input.value)
    this.input.onCursorChange = () => void this.updateImagePreview()
    this.input.onImagePaste = (event) => void this.addPastedImage(event)

    renderer.keyInput.on("keypress", (key) => {
      if (key.ctrl && key.name === "c") {
        callbacks.onQuit()
        return
      }
      if ((key.super || key.meta || key.ctrl) && key.name === "v" && this.input.focused) {
        key.preventDefault()
        void this.pasteImageFromSystemClipboard()
        return
      }
      if (key.ctrl && key.name === "p") {
        this.openSessionPicker()
        key.preventDefault()
        return
      }
      if (key.name === "escape" && this.pickerOverlay !== undefined) {
        this.closePicker()
        return
      }
      if (this.pickerSelect !== undefined && !key.ctrl && !key.meta && !key.super) {
        if (key.name === "j" || key.name === "k") {
          if (key.name === "j") this.pickerSelect.moveDown()
          else this.pickerSelect.moveUp()
          key.preventDefault()
          return
        }
      }
      if (key.super && key.name === "l") {
        this.input.focus()
        this.transcript.scrollTo(Number.MAX_SAFE_INTEGER)
        key.preventDefault()
        return
      }
      if (key.name === "escape" && this.input.focused) {
        this.dismissedSlashCommandValue = this.input.value
        this.hideSlashCommandMenu()
        this.input.blur()
        key.preventDefault()
        return
      }
      if (!this.input.focused && !key.ctrl && !key.meta && !key.super) {
        if (key.name === "j" || key.name === "k") {
          this.transcript.scrollBy(key.name === "j" ? 3 : -3)
          key.preventDefault()
          return
        }
      }
      if (this.handleSlashCommandCompletionKey(key)) return
      if (key.name === "escape" && this.busy) callbacks.onInterrupt()
    })

    this.input.focus()
  }

  get currentSessionId(): string | undefined {
    return this.sessionId
  }

  private activeAttachments(value = this.input.value): ReadonlyArray<CodexImageInput> {
    return [...this.attachments.entries()]
      .filter(([token]) => value.includes(token))
      .map(([, attachment]) => attachment)
  }

  private async addPastedImage(event: PasteEvent): Promise<void> {
    event.preventDefault()
    event.stopPropagation()
    if (event.bytes.length === 0) await this.pasteImageFromSystemClipboard()
    else await this.addPastedImageBytes(event.bytes, event.metadata?.mimeType)
  }

  private async pasteImageFromSystemClipboard(): Promise<void> {
    const image = await readMacClipboardImage()
    if (image !== undefined) await this.addPastedImageBytes(image.bytes, image.mimeType)
  }

  private async addPastedImageBytes(bytes: Uint8Array, mime?: string): Promise<void> {
    const format = detectImageFormat(bytes)
    const extension = format?.toLowerCase().replace("jpeg", "jpg")
      ?? mime?.split("/")[1]?.replace("jpeg", "jpg")
      ?? "img"
    const path = join(tmpdir(), `goxt-${crypto.randomUUID()}.${extension}`)
    await Bun.write(path, bytes)
    const label = `[Image #${this.nextImageNumber++}]`
    this.attachments.set(label, { path, label })
    this.input.insertText(label)
    await this.showImagePreview(label)
  }

  private async updateImagePreview(): Promise<void> {
    const cursor = this.input.cursorOffset
    const match = [...this.attachments.keys()].find((token) => {
      const start = this.input.value.indexOf(token)
      return start >= 0 && cursor >= start && cursor <= start + token.length
    })
    if (match === undefined) this.hideImagePreview()
    else await this.showImagePreview(match)
  }

  private async showImagePreview(token: string): Promise<void> {
    const attachment = this.attachments.get(token)
    if (attachment === undefined || !this.input.value.includes(token)) return
    try {
      const width = Math.min(70, Math.max(20, this.renderer.width - 12))
      const height = Math.min(18, Math.max(8, this.renderer.height - 10))
      const source = decodeImage(new Uint8Array(await Bun.file(attachment.path).arrayBuffer()))
      const image = resizeImage(source, width, height * 2)
      if (!this.input.value.includes(token)) return
      this.imagePreview.width = image.width + 2
      this.imagePreview.height = Math.ceil(image.height / 2) + 2
      this.imagePreview.left = Math.max(0, Math.floor((this.renderer.width - this.imagePreview.width) / 2))
      this.imagePreview.bottom = this.composer.height + 1
      this.imagePreview.title = `${token} · ${source.format} · ${source.width}×${source.height}`
      const shades = " .:-=+*#%@"
      const rows: string[] = []
      for (let y = 0; y < image.height; y += 2) {
        let row = ""
        for (let x = 0; x < image.width; x += 1) {
          const top = (y * image.width + x) * 4
          const bottom = (Math.min(image.height - 1, y + 1) * image.width + x) * 4
          const luminance = (
            image.data[top]! * 0.2126 + image.data[top + 1]! * 0.7152 + image.data[top + 2]! * 0.0722 +
            image.data[bottom]! * 0.2126 + image.data[bottom + 1]! * 0.7152 + image.data[bottom + 2]! * 0.0722
          ) / 2
          row += shades[Math.min(shades.length - 1, Math.floor(luminance / 256 * shades.length))]
        }
        rows.push(row)
      }
      this.imagePreviewBitmap.content = rows.join("\n")
      this.imagePreview.visible = true
      if (this.writeTerminal !== undefined && this.renderer.capabilities?.kitty_graphics) {
        // Wait until OpenTUI has laid out and painted the overlay, then place a
        // Kitty image in its content rectangle. Ghostty supports this protocol.
        await this.renderer.idle()
        const previewPath = `${attachment.path}.preview.png`
        await Bun.write(previewPath, encodeImageAsPng(source))
        const path = Buffer.from(previewPath).toString("base64")
        const column = this.imagePreview.screenX + 2
        const row = this.imagePreview.screenY + 2
        const columns = Math.max(1, this.imagePreview.width - 2)
        const rows = Math.max(1, this.imagePreview.height - 2)
        this.writeTerminal(
          `\x1b7\x1b[${row};${column}H` +
          `\x1b_Ga=T,t=f,f=100,q=2,C=1,i=${this.kittyImageId},c=${columns},r=${rows};${path}\x1b\\` +
          "\x1b8",
        )
        // The real bitmap replaces the character fallback on capable terminals.
        this.imagePreviewBitmap.content = ""
      }
    } catch {
      this.hideImagePreview()
    }
  }

  private hideImagePreview(): void {
    if (this.imagePreview.visible && this.writeTerminal !== undefined) {
      this.writeTerminal(`\x1b_Ga=d,d=i,i=${this.kittyImageId},q=2\x1b\\`)
    }
    this.imagePreview.visible = false
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

  setSessions(sessions: ReadonlyArray<CodexSession>): void {
    this.sessions = sessions
    if (sessions.length === 0) {
      this.showCommandMessage("sessions", "No Codex sessions were found for this workspace.")
      return
    }
    this.openSessionPicker()
  }

  showSessionHistory(history: CodexSessionHistory): void {
    this.clearSession()
    this.sessionId = history.session.id
    this.welcome.visible = history.messages.length === 0
    this.transcript.visible = history.messages.length > 0
    for (const message of history.messages) {
      if (message.role === "user") this.addMessage("you", message.text, theme.user)
      else this.addMarkdownMessage("codex", message.text, theme.accent).streaming = false
    }
    this.setStatus(t`${fg(history.session.status === "systemError" ? theme.error : theme.accent)(
      history.session.status === "active" ? "● running" :
      history.session.status === "waiting" ? "◆ input needed" :
      history.session.status === "systemError" ? "× error" : "● ready",
    )}`)
    this.input.placeholder = history.session.status === "active" || history.session.status === "waiting"
      ? "This session is running in the background…"
      : "Continue this session, or type /help…"
    this.input.focus()
  }

  begin(prompt: string): void {
    this.busy = true
    this.turnStartedAt = Date.now()
    this.thoughtRecorded = false
    this.workedRecorded = false
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
        this.finalizeStreamingMarkdown()
        this.planBody = undefined
        break
      case "AgentMessageDelta": {
        let message = this.streamingMessages.get(event.itemId)
        if (message === undefined) {
          this.addThoughtSummary()
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
          this.addThoughtSummary()
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
        this.showSpinner(event.label)
        break
      case "PlanUpdated": {
        const plan = event.steps
          .map((step) => `${step.status === "completed" ? "✓" : step.status === "inProgress" ? "→" : "·"} ${step.step}`)
          .join("\n")
        if (this.planBody === undefined) this.planBody = this.addMessage("plan", plan, theme.muted)
        else this.planBody.content = plan
        break
      }
      case "TokenUsage":
        this.latestTokenUsage = {
          totalTokens: event.totalTokens,
          lastTokens: event.lastTokens,
          contextWindow: event.contextWindow,
        }
        this.updateSettingsStatus()
        break
      case "ApprovalRequested":
        this.welcome.visible = false
        this.transcript.visible = true
        this.pendingInteractions.set(event.requestId, {
          _tag: "Approval",
          requestId: event.requestId,
          availableDecisions: event.availableDecisions,
          responding: false,
          expired: false,
        })
        this.hideSlashCommandMenu()
        this.addMessage("approval", event.prompt, theme.accent)
        this.setStatus(t`${fg(theme.accent)("● approval needed")}`)
        if (event.availableDecisions.length === 0) {
          const interaction = this.pendingInteractions.get(event.requestId)
          if (interaction !== undefined) interaction.expired = true
          this.addMessage("approval", unsupportedApprovalMessage, theme.error)
        }
        this.activateNextInteraction()
        break
      case "UserInputRequested": {
        this.welcome.visible = false
        this.transcript.visible = true
        const interaction: PendingInteraction = {
          _tag: "UserInput",
          requestId: event.requestId,
          questionIds: event.questions.map((question) => question.id),
          isSecret: event.questions.some((question) => question.isSecret),
          responding: false,
          expired: false,
        }
        this.pendingInteractions.set(event.requestId, interaction)
        this.hideSlashCommandMenu()
        const content = event.questions
          .map((question) => {
            const options = question.options?.map((option) => option.label).join(" / ")
            return options ? `${question.question}\n${options}` : question.question
        })
          .join("\n\n")
        this.addMessage("codex · question", content, theme.accent)
        this.setStatus(t`${fg(theme.accent)("● input needed")}`)
        if (interaction.isSecret) {
          this.addMessage(
            "security",
            "Secret input is unsupported by this terminal control. The request was rejected without collecting or displaying a secret.",
            theme.error,
          )
          interaction.responding = true
          const answers = Object.fromEntries(
            interaction.questionIds.map((id) => [id, { answers: [] }]),
          )
          void Promise.resolve(this.onUserInput(interaction.requestId, { answers })).then(
            () => this.resolveInteraction(interaction.requestId),
            () => this.restoreInteraction(interaction.requestId),
          )
        } else this.activateNextInteraction()
        if (event.autoResolutionMs !== null) {
          this.scheduleAutoResolution(event.requestId, event.autoResolutionMs)
        }
        break
      }
      case "ServerRequestResolved":
        this.resolveInteraction(event.requestId)
        break
      case "TurnFailed":
        this.finishTurnState()
        this.setStatus(t`${fg(theme.error)("●")} ${fg(theme.error)(event.message)}`)
        break
      case "TurnCompleted":
        this.finishTurnState()
        break
      case "Unknown":
        break
    }
  }

  complete(): void {
    this.busy = false
    this.finishTurnState()
    this.setStatus(t`${fg(theme.accent)("● ready")}`)
    this.input.placeholder = "Continue the session, or type /help…"
    this.input.focus()
  }

  interrupted(): void {
    this.busy = false
    this.finishTurnState()
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
    this.finishTurnState()
    this.addMessage("error", message, theme.error)
    this.setStatus(t`${fg(theme.error)("● failed")} ${fg(theme.muted)("· check the message above")}`)
    this.input.placeholder = "Try another prompt, or type /help…"
    this.input.focus()
  }

  destroy(): void {
    this.clearInteractions()
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
      this.activeInteraction() !== undefined ||
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
    if (this.busy && command._tag !== "Sessions") {
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
          "/sessions              switch sessions (Ctrl+P)\n/clear                 start a new session and clear the screen\n/model                 open model picker\n/model <id>            switch model directly\n/model default         use the catalog default\n/reasoning             open reasoning picker\n/reasoning <level>     switch reasoning directly\n/reasoning default     use the model default\n/usage                 show account limits and context usage",
        )
        return
      case "Usage":
        this.showCommandMessage("usage", "Fetching current limits…")
        this.onUsage?.()
        return
      case "Sessions":
        this.openSessionPicker()
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

  private openSessionPicker(): void {
    if (this.pickerOverlay !== undefined) return
    if (this.sessions.length === 0) {
      this.showCommandMessage("sessions", "Loading Codex sessions…")
      this.onSessions?.()
      return
    }
    const statusLabel = (status: CodexSession["status"]): string => ({
      active: "● running",
      waiting: "◆ needs input",
      idle: "○ idle",
      notLoaded: "○ idle",
      systemError: "× error",
    })[status]
    const options: ReadonlyArray<SelectOption> = this.sessions.map((session) => ({
      name: `${statusLabel(session.status)}  ${session.title}`,
      description: `${new Date(session.updatedAt * 1_000).toLocaleString()} · ${session.id.slice(0, 8)}`,
      value: session.id,
    }))
    const selected = Math.max(0, this.sessions.findIndex((session) => session.id === this.sessionId))
    this.openPicker(
      "Codex sessions",
      "Switching views does not interrupt running sessions.",
      options,
      selected,
      (index) => {
        const session = this.sessions[index]
        if (session === undefined || session.id === this.sessionId) return
        this.setStatus(t`${fg(theme.accent)("● loading session…")}`)
        this.input.placeholder = "Loading session history…"
        this.input.blur()
        this.onSessionSelect?.(session.id)
      },
    )
  }

  private clearSession(): void {
    this.sessionId = undefined
    this.latestTokenUsage = undefined
    this.clearInteractions()
    this.planBody = undefined
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
        content: "↑↓/jk navigate   Enter select   Esc cancel",
        fg: theme.subtle,
        height: 1,
        selectable: false,
      }),
    )
    overlay.add(dialog)
    this.renderer.root.add(overlay)
    this.pickerOverlay = overlay
    this.pickerSelect = select
    this.input.blur()
    select.focus()
  }

  private closePicker(focusInput = true): void {
    const overlay = this.pickerOverlay
    if (overlay === undefined) return
    this.pickerOverlay = undefined
    this.pickerSelect = undefined
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
    const contextLabel =
      this.latestTokenUsage === undefined
        ? undefined
        : this.latestTokenUsage.contextWindow === null
          ? `context ${formatTokens(this.latestTokenUsage.lastTokens)}`
          : `context ${formatTokens(this.latestTokenUsage.lastTokens)}/${formatTokens(this.latestTokenUsage.contextWindow)}`
    this.settingsStatus.content = t`${fg(theme.subtle)(
      [modelLabel, effortLabel, contextLabel].filter(Boolean).join(" · "),
    )}`
  }

  showUsage(rateLimits: CodexRateLimits): void {
    this.showCommandMessage("usage", formatCodexUsage(rateLimits, this.latestTokenUsage))
  }

  usageFailed(message: string): void {
    this.showCommandMessage("usage", message, true)
  }

  private showSpinner(label?: string): void {
    this.status.content = label === undefined ? "" : t`${fg(theme.muted)(` ${label}`)}`
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

  private parseApproval(
    value: string,
    availableDecisions: ReadonlyArray<ApprovalDecision>,
  ): ApprovalDecision | undefined {
    let decision: ApprovalDecision | undefined
    switch (value.toLowerCase()) {
      case "y":
      case "yes":
      case "accept":
        decision = "accept"
        break
      case "session":
      case "always":
        decision = "acceptForSession"
        break
      case "n":
      case "no":
      case "decline":
        decision = "decline"
        break
      case "cancel":
        decision = "cancel"
        break
      default:
        return undefined
    }
    return availableDecisions.includes(decision) ? decision : undefined
  }

  private activeInteraction(): PendingInteraction | undefined {
    return [...this.pendingInteractions.values()].find(
      (interaction) =>
        !interaction.responding &&
        !interaction.expired &&
        (interaction._tag === "Approval" || !interaction.isSecret),
    )
  }

  private applyResponsiveLayout(width: number, height: number): void {
    const narrow = width < 60
    const tiny = width < 40 || height < 14
    const horizontalPadding = narrow ? 1 : 3
    this.shell.paddingX = horizontalPadding
    this.slashCommandMenu.left = horizontalPadding
    this.shell.paddingY = tiny ? 0 : 1
    this.headerPath.visible = !narrow
    this.settingsStatus.visible = width >= 70
    this.statusGroup.width = width < 70 ? "100%" : "50%"
    this.welcome.width = narrow ? "100%" : 72
    this.welcome.paddingX = narrow ? 1 : 3
    this.welcome.paddingY = height < 18 ? 1 : 2
    this.welcome.gap = height < 18 ? 0 : 1
    if (!this.busy && this.sessionId === undefined) this.welcome.visible = !tiny
  }

  private updateComposerHeight(): void {
    const availableWidth = Math.max(1, this.input.width)
    const wrappedRows = this.input.value
      .split("\n")
      .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / availableWidth)), 0)
    const rows = Math.max(
      1,
      Math.min(6, Math.max(this.input.virtualLineCount, this.input.lineCount, wrappedRows)),
    )
    this.input.height = rows
    this.composer.height = rows + 2
    this.slashCommandMenu.bottom = rows + 3
  }

  private activateNextInteraction(): void {
    const interaction = this.activeInteraction()
    if (interaction === undefined) {
      this.input.placeholder = this.busy ? "Steer the active turn…" : "Ask Codex, or type /help…"
      this.input.focus()
      return
    }
    if (interaction._tag === "Approval") {
      const labels = interaction.availableDecisions.map((decision) =>
        decision === "acceptForSession" ? "session" : decision,
      )
      this.input.placeholder = `Type ${labels.join(", ")}…`
    } else {
      this.input.placeholder =
        interaction.questionIds.length > 1
          ? "Answer each question separated by | …"
          : "Type your answer…"
    }
    this.input.focus()
  }

  private resolveInteraction(requestId: number | string): void {
    this.clearInteractionTimer(requestId)
    this.pendingInteractions.delete(requestId)
    this.activateNextInteraction()
  }

  private restoreInteraction(requestId: number | string): void {
    const interaction = this.pendingInteractions.get(requestId)
    if (interaction === undefined) return
    if (interaction._tag === "UserInput" && interaction.isSecret) {
      interaction.expired = true
      this.addMessage(
        "error",
        "Could not reject the secret request; waiting for Codex to resolve it.",
        theme.error,
      )
      this.activateNextInteraction()
      return
    }
    interaction.responding = false
    this.addMessage(
      "error",
      "Could not send the response. The request is still pending.",
      theme.error,
    )
    this.activateNextInteraction()
  }

  private scheduleAutoResolution(requestId: number | string, delay: number): void {
    this.clearInteractionTimer(requestId)
    const timer = setTimeout(() => {
      this.interactionTimers.delete(requestId)
      const interaction = this.pendingInteractions.get(requestId)
      if (interaction === undefined) return
      this.pendingInteractions.delete(requestId)
      this.addMessage(
        "codex · question",
        "This request reached its automatic-resolution deadline.",
        theme.muted,
      )
      this.activateNextInteraction()
    }, Math.max(0, delay))
    this.interactionTimers.set(requestId, timer)
  }

  private clearInteractionTimer(requestId: number | string): void {
    const timer = this.interactionTimers.get(requestId)
    if (timer !== undefined) clearTimeout(timer)
    this.interactionTimers.delete(requestId)
  }

  private clearInteractions(): void {
    for (const timer of this.interactionTimers.values()) clearTimeout(timer)
    this.interactionTimers.clear()
    this.pendingInteractions.clear()
  }

  private finishTurnState(): void {
    this.finalizeStreamingMarkdown()
    this.clearInteractions()
    this.addWorkedSummary()
  }

  private addThoughtSummary(): void {
    if (this.thoughtRecorded) return
    this.thoughtRecorded = true
    const elapsed = this.turnStartedAt === undefined ? 0 : Date.now() - this.turnStartedAt
    const row = new TextRenderable(this.renderer, {
      content: t`${fg(theme.muted)("◆")} ${bold(fg(theme.muted)("Thought"))} ${fg(theme.subtle)(`for ${formatElapsed(elapsed)}`)}`,
      height: 1,
      marginBottom: 1,
      marginLeft: 2,
      selectable: false,
    })
    this.transcript.add(row)
  }

  private addWorkedSummary(): void {
    if (this.workedRecorded || this.turnStartedAt === undefined || !this.thoughtRecorded) return
    this.workedRecorded = true
    const elapsed = Date.now() - this.turnStartedAt
    this.transcript.add(
      new TextRenderable(this.renderer, {
        content: `Worked for ${formatElapsed(elapsed)}.`,
        fg: theme.subtle,
        height: 1,
        marginBottom: 2,
        marginLeft: 2,
        selectable: false,
      }),
    )
    this.transcript.scrollTo(Number.MAX_SAFE_INTEGER)
  }

  private finalizeStreamingMarkdown(): void {
    for (const message of this.streamingMessages.values()) message.renderable.streaming = false
    this.streamingMessages.clear()
  }

  private addMessage(label: string, content: string, color: string): TextRenderable {
    if (label === "you" || label === "you · steer") {
      const message = new BoxRenderable(this.renderer, {
        width: "100%",
        minHeight: 3,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 2,
        paddingX: 2,
        backgroundColor: theme.surface,
      })
      const body = new TextRenderable(this.renderer, {
        content: t`${bold(fg(theme.text)("›"))} ${bold(fg(theme.text)(content))}`,
        flexGrow: 1,
      })
      message.add(body)
      message.add(
        new TextRenderable(this.renderer, {
          content: formatMessageTime().padStart(10),
          fg: theme.subtle,
          width: 10,
          selectable: false,
        }),
      )
      this.transcript.add(message)
      this.transcript.scrollTo(Number.MAX_SAFE_INTEGER)
      return body
    }

    const message = new BoxRenderable(this.renderer, {
      width: "100%",
      flexDirection: "column",
      marginBottom: 2,
      paddingX: 2,
    })
    message.add(
      new TextRenderable(this.renderer, {
        content: t`${fg(color)("◆")} ${bold(fg(color)(label))}`,
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
      marginBottom: 2,
      paddingX: 2,
    })
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
