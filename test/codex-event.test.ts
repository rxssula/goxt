import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { parseCodexNotification, parseCodexServerRequest } from "../src/codex/event.js"

describe("Codex app-server events", () => {
  test("decodes a thread id", async () => {
    const event = await Effect.runPromise(
      parseCodexNotification({
        method: "thread/started",
        params: { thread: { id: "019f-test" } },
      }),
    )

    expect(event).toEqual({ _tag: "ThreadStarted", threadId: "019f-test" })
  })

  test("decodes streaming assistant text", async () => {
    const event = await Effect.runPromise(
      parseCodexNotification({
        method: "item/agentMessage/delta",
        params: { threadId: "thread", turnId: "turn", itemId: "item_1", delta: "Done." },
      }),
    )

    expect(event).toEqual({ _tag: "AgentMessageDelta", itemId: "item_1", delta: "Done." })
  })

  test("turns command starts into concise activity", async () => {
    const event = await Effect.runPromise(
      parseCodexNotification({
        method: "item/started",
        params: {
          item: { id: "item_2", type: "commandExecution", command: "bun test" },
          threadId: "thread",
          turnId: "turn",
        },
      }),
    )

    expect(event).toEqual({ _tag: "Activity", label: "Running bun test" })
  })

  test("decodes token usage with context-window details", async () => {
    const event = await Effect.runPromise(
      parseCodexNotification({
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            total: { totalTokens: 5000 },
            last: { totalTokens: 1200 },
            modelContextWindow: 128000,
          },
        },
      }),
    )

    expect(event).toEqual({
      _tag: "TokenUsage",
      totalTokens: 5000,
      lastTokens: 1200,
      contextWindow: 128000,
    })
  })

  test("retains unknown notifications losslessly", async () => {
    const params = { future: true }
    const event = await Effect.runPromise(
      parseCodexNotification({ method: "future/event", params }),
    )

    expect(event).toEqual({ _tag: "Unknown", method: "future/event", params })
  })

  test("decodes reverse approval requests", async () => {
    const event = await Effect.runPromise(
      parseCodexServerRequest({
        id: 4,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          command: "bun test",
          reason: "needs permission",
        },
      }),
    )

    expect(event._tag).toBe("ApprovalRequested")
    if (event._tag === "ApprovalRequested") {
      expect(event.prompt).toContain("bun test")
      expect(event.requestId).toBe(4)
    }
  })
})
