import { afterEach, describe, expect, test } from "bun:test"
import {
  createMockKeys,
  createTestRenderer,
  type TestRendererSetup,
} from "@opentui/core/testing"
import { HarnessView } from "../src/ui/harness-view.js"
import type { ApprovalDecision, CodexModel, CodexTurnSettings } from "../src/codex/types.js"

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
    const { renderer, waitFor, captureCharFrame } = testRenderer

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

    await waitFor(() => {
      renderer.requestRender()
      return captureCharFrame().includes("Result")
    })
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
    const keys = createMockKeys(renderer, { kittyKeyboard: true })
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
    const keys = createMockKeys(renderer, { kittyKeyboard: true })
    const submissions: Array<string> = []
    const view = new HarnessView(renderer, "/workspace/goxt", {
      ...callbacks,
      onSubmit: (prompt) => submissions.push(prompt),
    })
    view.setModels(models)

    view.input.value = "/model"
    view.input.submit()
    keys.pressEscape()
    await testRenderer.waitForFrame((frame) => !frame.includes("Choose model"))
    view.input.value = "Continue normally"
    view.input.submit()

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

  test("fetches usage and renders context-window details", async () => {
    testRenderer = await createTestRenderer({ width: 110, height: 36 })
    const { renderer, renderOnce, captureCharFrame } = testRenderer
    let usageRequests = 0
    const view = new HarnessView(renderer, "/workspace/goxt", {
      ...callbacks,
      onUsage: () => {
        usageRequests += 1
      },
    })
    view.handleEvent({
      _tag: "TokenUsage",
      totalTokens: 5000,
      lastTokens: 1200,
      contextWindow: 128000,
    })
    view.input.value = "/usage"
    view.input.submit()
    view.showUsage({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
        secondary: null,
        planType: "plus",
      },
      rateLimitsByLimitId: null,
    })
    await renderOnce()

    expect(usageRequests).toBe(1)
    expect(captureCharFrame()).toContain("Latest turn: 1,200 tokens")
    expect(captureCharFrame()).toContain("Capacity: 128,000 tokens")
    expect(captureCharFrame()).toContain("12% used")
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

  test("queues reverse requests, honors decisions, and retains failed responses", async () => {
    testRenderer = await createTestRenderer({ width: 80, height: 24 })
    const { renderer, waitForFrame } = testRenderer
    let attempts = 0
    const decisions: Array<ApprovalDecision> = []
    const view = new HarnessView(renderer, "/workspace/goxt", {
      ...callbacks,
      onApproval: async (_id, decision) => {
        decisions.push(decision)
        attempts += 1
        if (attempts === 1) throw new Error("retry")
      },
    })
    view.handleEvent({
      _tag: "ApprovalRequested",
      requestId: 1,
      kind: "command",
      prompt: "Allow first?",
      availableDecisions: ["decline", "cancel"],
      params: { threadId: "t", turnId: "turn", itemId: "one" },
    })
    view.handleEvent({
      _tag: "ApprovalRequested",
      requestId: 2,
      kind: "file-change",
      prompt: "Allow second?",
      availableDecisions: ["accept"],
      params: { threadId: "t", turnId: "turn", itemId: "two" },
    })

    view.input.value = "y"
    view.input.submit()
    expect(decisions).toEqual([])
    view.input.value = "n"
    view.input.submit()
    await testRenderer.flush()
    await waitForFrame((frame) => frame.includes("still pending"))
    view.input.value = "n"
    view.input.submit()
    await testRenderer.flush()
    view.input.value = "y"
    view.input.submit()
    await testRenderer.flush()
    expect(decisions).toEqual(["decline", "decline", "accept"])
  })

  test("keeps the unsupported approval explanation visible", async () => {
    testRenderer = await createTestRenderer({ width: 80, height: 24 })
    const { renderer, waitForFrame } = testRenderer
    const view = new HarnessView(renderer, "/workspace/goxt", callbacks)

    view.handleEvent({
      _tag: "ApprovalRequested",
      requestId: "unsupported",
      kind: "command",
      prompt: "Allow an unsupported command?",
      availableDecisions: [],
      params: { threadId: "t", turnId: "turn", itemId: "item" },
    })

    await waitForFrame((frame) => frame.includes("No supported approval decision"))
  })

  test("keeps invalid approval guidance limited to available decisions", async () => {
    testRenderer = await createTestRenderer({ width: 80, height: 24 })
    const { renderer } = testRenderer
    const view = new HarnessView(renderer, "/workspace/goxt", callbacks)
    view.handleEvent({
      _tag: "ApprovalRequested",
      requestId: 1,
      kind: "file-change",
      prompt: "Allow the file change?",
      availableDecisions: ["accept"],
      params: { threadId: "t", turnId: "turn", itemId: "item" },
    })

    view.input.value = "n"
    view.input.submit()

    expect(view.input.placeholder).toBe("Type accept…")
  })

  test("drops unresolved interactions when a turn ends", async () => {
    testRenderer = await createTestRenderer({ width: 80, height: 24 })
    const { renderer } = testRenderer
    const approvals: Array<ApprovalDecision> = []
    const submissions: Array<string> = []
    const view = new HarnessView(renderer, "/workspace/goxt", {
      ...callbacks,
      onApproval: (_id, decision) => {
        approvals.push(decision)
      },
      onSubmit: (prompt) => submissions.push(prompt),
    })
    view.begin("Start")
    view.handleEvent({
      _tag: "ApprovalRequested",
      requestId: "stale",
      kind: "command",
      prompt: "Allow stale command?",
      availableDecisions: ["accept"],
      params: { threadId: "t", turnId: "turn", itemId: "stale" },
    })

    view.complete()
    view.input.value = "Fresh prompt"
    view.input.submit()

    expect(approvals).toEqual([])
    expect(submissions).toEqual(["Fresh prompt"])
  })

  test("rejects secret input without rendering or collecting plaintext", async () => {
    testRenderer = await createTestRenderer({ width: 80, height: 24 })
    const { renderer, waitForFrame, captureCharFrame } = testRenderer
    const responses: Array<unknown> = []
    const view = new HarnessView(renderer, "/workspace/goxt", {
      ...callbacks,
      onUserInput: (_id, response) => {
        responses.push(response)
      },
    })
    view.handleEvent({
      _tag: "UserInputRequested",
      requestId: "secret",
      autoResolutionMs: null,
      questions: [{ id: "token", header: "Token", question: "Enter token", isOther: false, isSecret: true, options: null }],
    })

    await waitForFrame((frame) => frame.includes("Secret input is unsupported"))
    expect(captureCharFrame()).not.toContain("super-secret")
    expect(responses).toEqual([{ answers: { token: { answers: [] } } }])
  })

  test("updates plan and activity in place and stays legible at compact sizes", async () => {
    testRenderer = await createTestRenderer({ width: 50, height: 16 })
    const { renderer, resize, waitForFrame, captureCharFrame } = testRenderer
    const view = new HarnessView(renderer, "/workspace/a/very/long/repository/path", callbacks)
    view.begin("Work")
    view.handleEvent({ _tag: "Activity", label: "Searching the web" })
    view.handleEvent({ _tag: "PlanUpdated", explanation: null, steps: [{ step: "First", status: "inProgress" }] })
    view.handleEvent({ _tag: "PlanUpdated", explanation: null, steps: [{ step: "Second", status: "completed" }] })
    await waitForFrame((frame) => frame.includes("Searching the web") && frame.includes("Second"))
    expect(captureCharFrame()).not.toContain("First")
    expect(captureCharFrame().match(/plan/g)?.length).toBe(1)

    resize(35, 12)
    await waitForFrame((frame) => frame.includes("Steer the active turn"))
    expect(captureCharFrame()).not.toContain("/workspace/a/very/long")
  })
})
