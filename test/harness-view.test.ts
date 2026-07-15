import { afterEach, describe, expect, test } from "bun:test"
import {
  createMockKeys,
  createTestRenderer,
  type TestRendererSetup,
} from "@opentui/core/testing"
import { HarnessView } from "../src/ui/harness-view.js"
import type { CodexModel, CodexTurnSettings } from "../src/codex/types.js"

let testRenderer: TestRendererSetup | undefined

const callbacks = {
  onSubmit: () => undefined,
  onSteer: () => undefined,
  onInterrupt: () => undefined,
  onApproval: () => undefined,
  onUserInput: () => undefined,
  onQuit: () => undefined,
}

const models: ReadonlyArray<CodexModel> = [
  {
    id: "gpt-default",
    model: "gpt-default",
    displayName: "GPT Default",
    description: "The default model.",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "high", description: "Deep" },
    ],
    defaultReasoningEffort: "low",
    isDefault: true,
  },
  {
    id: "gpt-deep",
    model: "gpt-deep",
    displayName: "GPT Deep",
    description: "The deeper model.",
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: false,
  },
]

afterEach(() => {
  testRenderer?.renderer.destroy()
  testRenderer = undefined
})

describe("HarnessView", () => {
  test("renders the minimal welcome state", async () => {
    testRenderer = await createTestRenderer({ width: 100, height: 30 })
    const { renderer, renderOnce, captureCharFrame } = testRenderer

    const view = new HarnessView(renderer, "/workspace/goxt", callbacks)
    view.setCodexStatus({ available: true, authenticated: true, version: "0.144.1" })

    await renderOnce()
    const frame = captureCharFrame()

    expect(frame).toContain("goxt")
    expect(frame).not.toContain("/ codex harness")
    expect(frame).toContain("A quiet terminal harness for Codex.")
    expect(frame).toContain("● ready")
    expect(frame).not.toContain("local Codex session")
    expect(frame).not.toContain("codex 0.144.1")
    expect(frame).toContain("Ask Codex, or type /help…")
  })

  test("switches to the transcript while running", async () => {
    testRenderer = await createTestRenderer({ width: 100, height: 30 })
    const { renderer, renderOnce, captureCharFrame } = testRenderer

    const view = new HarnessView(renderer, "/workspace/goxt", callbacks)
    view.begin("Inspect the repository")
    view.handleEvent({
      _tag: "AgentMessageDelta",
      itemId: "message-1",
      delta: "The repository is ready.",
    })

    await renderOnce()
    const frame = captureCharFrame()

    expect(frame).not.toContain("starting Codex")
    expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    expect(frame).toContain("you")
    expect(frame).toContain("Inspect the repository")
    expect(frame).toContain("codex")
    expect(frame).toContain("The repository is ready.")
  })

  test("renders agent Markdown and hides fenced-code markers", async () => {
    testRenderer = await createTestRenderer({ width: 100, height: 36 })
    const { renderer, renderOnce, captureCharFrame } = testRenderer

    const view = new HarnessView(renderer, "/workspace/goxt", callbacks)
    view.begin("Show me the result")
    view.handleEvent({
      _tag: "AgentMessageCompleted",
      itemId: "message-1",
      text: [
        "# Result",
        "",
        "The answer is **ready** and uses `MarkdownRenderable`.",
        "",
        "```typescript",
        "const answer: number = 42",
        "```",
      ].join("\n"),
    })

    await renderOnce()
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    await renderOnce()
    const frame = captureCharFrame()

    expect(frame).toContain("Result")
    expect(frame).toContain("The answer is ready")
    expect(frame).toContain("const answer: number = 42")
    expect(frame).not.toContain("# Result")
    expect(frame).not.toContain("```typescript")
  })

  test("opens a model picker without submitting a turn", async () => {
    testRenderer = await createTestRenderer({ width: 100, height: 30 })
    const { renderer, renderOnce, captureCharFrame } = testRenderer
    let submissions = 0
    const view = new HarnessView(renderer, "/workspace/goxt", {
      ...callbacks,
      onSubmit: () => {
        submissions += 1
      },
    })
    view.setModels(models)

    view.input.value = "/model"
    view.input.submit()
    await renderOnce()
    const frame = captureCharFrame()

    expect(submissions).toBe(0)
    expect(frame).toContain("Choose model")
    expect(frame).toContain("GPT Default  gpt-default")
    expect(frame).toContain("GPT Deep  gpt-deep")
    expect(frame).toContain("↑↓ navigate   Enter select   Esc cancel")
  })

  test("applies picker selections to the next turn", async () => {
    testRenderer = await createTestRenderer({ width: 100, height: 30 })
    const { renderer } = testRenderer
    const keys = createMockKeys(renderer)
    const submissions: Array<{ prompt: string; settings: CodexTurnSettings }> = []
    const view = new HarnessView(renderer, "/workspace/goxt", {
      ...callbacks,
      onSubmit: (prompt, settings) => submissions.push({ prompt, settings }),
    })
    view.setModels(models)

    view.input.value = "/model"
    view.input.submit()
    keys.pressArrow("down")
    keys.pressEnter()

    view.input.value = "/reasoning"
    view.input.submit()
    keys.pressArrow("down")
    keys.pressEnter()

    view.input.value = "Inspect the repository"
    view.input.submit()

    expect(submissions).toEqual([
      {
        prompt: "Inspect the repository",
        settings: { model: "gpt-deep", reasoningEffort: "high" },
      },
    ])
  })

  test("restores saved settings and reports later changes", async () => {
    testRenderer = await createTestRenderer({ width: 100, height: 30 })
    const { renderer } = testRenderer
    const submissions: Array<CodexTurnSettings> = []
    const changes: Array<CodexTurnSettings> = []
    const view = new HarnessView(
      renderer,
      "/workspace/goxt",
      {
        ...callbacks,
        onSubmit: (_prompt, settings) => submissions.push(settings),
        onSettingsChange: (settings) => changes.push(settings),
      },
      { model: "gpt-deep", reasoningEffort: "high" },
    )
    view.setModels(models)

    view.input.value = "Use the saved model"
    view.input.submit()

    expect(submissions).toEqual([{ model: "gpt-deep", reasoningEffort: "high" }])

    view.input.value = "/model gpt-default"
    view.input.submit()

    expect(changes).toEqual([{ model: "gpt-default", reasoningEffort: "high" }])
  })

  test("closes a picker with escape and restores the composer", async () => {
    testRenderer = await createTestRenderer({ width: 100, height: 30 })
    const { renderer, renderOnce, captureCharFrame } = testRenderer
    const keys = createMockKeys(renderer)
    const submissions: Array<string> = []
    const view = new HarnessView(renderer, "/workspace/goxt", {
      ...callbacks,
      onSubmit: (prompt) => submissions.push(prompt),
    })
    view.setModels(models)

    view.input.value = "/model"
    view.input.submit()
    keys.pressEscape()
    await new Promise((resolve) => setTimeout(resolve, 50))
    view.input.value = "Continue normally"
    view.input.submit()
    await renderOnce()

    expect(captureCharFrame()).not.toContain("Choose model")
    expect(submissions).toEqual(["Continue normally"])
  })

  test("does not send slash commands as steering input during a turn", async () => {
    testRenderer = await createTestRenderer({ width: 100, height: 30 })
    const { renderer } = testRenderer
    const steers: Array<string> = []
    const view = new HarnessView(renderer, "/workspace/goxt", {
      ...callbacks,
      onSteer: (prompt) => steers.push(prompt),
    })
    view.begin("Start working")

    view.input.value = "/reasoning high"
    view.input.submit()

    expect(steers).toEqual([])
  })

  test("shows and filters slash command completions", async () => {
    testRenderer = await createTestRenderer({ width: 100, height: 30 })
    const { renderer, renderOnce, captureCharFrame } = testRenderer
    const view = new HarnessView(renderer, "/workspace/goxt", callbacks)

    view.input.value = "/m"
    await renderOnce()
    const frame = captureCharFrame()

    expect(frame).toContain("› /model Choose the model for future turns")
    expect(frame).not.toContain("/reasoning Choose the reasoning effort")
  })

  test("completes slash commands with tab and the arrow keys", async () => {
    testRenderer = await createTestRenderer({ width: 100, height: 30 })
    const { renderer } = testRenderer
    const keys = createMockKeys(renderer)
    const view = new HarnessView(renderer, "/workspace/goxt", callbacks)

    view.input.value = "/"
    keys.pressArrow("down")
    keys.pressTab()

    expect(view.input.value).toBe("/model ")
  })

  test("completes a partial command with enter before running it", async () => {
    testRenderer = await createTestRenderer({ width: 100, height: 30 })
    const { renderer, renderOnce, captureCharFrame } = testRenderer
    const keys = createMockKeys(renderer)
    const view = new HarnessView(renderer, "/workspace/goxt", callbacks)
    view.setModels(models)

    view.input.value = "/m"
    keys.pressEnter()
    expect(view.input.value).toBe("/model")

    keys.pressEnter()
    await renderOnce()
    expect(captureCharFrame()).toContain("Choose model")
  })

  test("clears the transcript and resets the session", async () => {
    testRenderer = await createTestRenderer({ width: 100, height: 30 })
    const { renderer, renderOnce, captureCharFrame } = testRenderer
    const submissions: Array<string> = []
    const view = new HarnessView(renderer, "/workspace/goxt", {
      ...callbacks,
      onSubmit: (prompt) => submissions.push(prompt),
    })
    view.setCodexStatus({ available: true, authenticated: true, version: "0.144.1" })
    view.begin("Old prompt")
    view.handleEvent({ _tag: "ThreadStarted", threadId: "old-session" })
    view.handleEvent({
      _tag: "AgentMessageCompleted",
      itemId: "message-1",
      text: "Old response",
    })
    view.complete()

    view.input.value = "/clear"
    view.input.submit()
    await renderOnce()
    const frame = captureCharFrame()

    expect(view.currentSessionId).toBeUndefined()
    expect(frame).toContain("A quiet terminal harness for Codex.")
    expect(frame).toContain("● ready")
    expect(frame).not.toContain("new session")
    expect(frame).not.toContain("Old prompt")
    expect(frame).not.toContain("Old response")

    view.input.value = "Fresh prompt"
    view.input.submit()
    expect(submissions).toEqual(["Fresh prompt"])
  })
})
