import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  canReuseThread,
  getInterruptTarget,
  promptInput,
  rejectUnsupportedApproval,
} from "../src/codex/service.js"
import { unsupportedApprovalMessage } from "../src/codex/types.js"

describe("Codex app-server thread selection", () => {
  test("starts fresh when no session is requested", () => {
    expect(canReuseThread("old-session", undefined)).toBe(false)
  })

  test("reuses only the explicitly requested current session", () => {
    expect(canReuseThread("current-session", "current-session")).toBe(true)
    expect(canReuseThread("current-session", "another-session")).toBe(false)
  })

  test("rejects approval requests with no supported decisions at the protocol boundary", async () => {
    const errors: Array<[number | string, number, string]> = []
    const event = {
      _tag: "ApprovalRequested",
      requestId: "approval",
      kind: "command",
      prompt: "Allow a command?",
      availableDecisions: [],
      params: { threadId: "thread", turnId: "turn", itemId: "item" },
    } as const

    const rejected = await Effect.runPromise(
      rejectUnsupportedApproval(
        {
          respondError: (requestId, code, message) =>
            Effect.sync(() => {
              errors.push([requestId, code, message])
            }),
        },
        event.requestId,
        event,
      ),
    )

    expect(rejected).toBe(true)
    expect(errors).toEqual([["approval", -32602, unsupportedApprovalMessage]])
  })
})

describe("Codex prompt input", () => {
  test("turns local image paths into image inputs", () => {
    expect(promptInput("Inspect /tmp/screenshot.png please")).toEqual([
      { type: "text", text: "Inspect please", text_elements: [] },
      { type: "localImage", path: "/tmp/screenshot.png" },
    ])
  })

  test("turns Markdown image URLs into image inputs", () => {
    expect(promptInput("What is this? ![shot](https://example.com/shot.webp)")).toEqual([
      { type: "text", text: "What is this?", text_elements: [] },
      { type: "image", url: "https://example.com/shot.webp" },
    ])
  })

  test("rejects unresolvable pasted-image markers", () => {
    expect(() => promptInput("Look at [Image #1]")).toThrow("has no file path")
  })
})

describe("Codex app-server interrupt target", () => {
  test("is unavailable when the active run has no thread id", () => {
    expect(getInterruptTarget(undefined, "turn-id")).toBeUndefined()
  })

  test("is unavailable when the active run has no turn id", () => {
    expect(getInterruptTarget("thread-id", undefined)).toBeUndefined()
  })

  test("contains both identifiers when the active run is interruptible", () => {
    expect(getInterruptTarget("thread-id", "turn-id")).toEqual({
      threadId: "thread-id",
      turnId: "turn-id",
    })
  })
})
