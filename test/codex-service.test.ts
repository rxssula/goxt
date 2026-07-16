import { describe, expect, test } from "bun:test"
import { canReuseThread, getInterruptTarget } from "../src/codex/service.js"

describe("Codex app-server thread selection", () => {
  test("starts fresh when no session is requested", () => {
    expect(canReuseThread("old-session", undefined)).toBe(false)
  })

  test("reuses only the explicitly requested current session", () => {
    expect(canReuseThread("current-session", "current-session")).toBe(true)
    expect(canReuseThread("current-session", "another-session")).toBe(false)
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
