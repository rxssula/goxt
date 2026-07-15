import { describe, expect, test } from "bun:test"
import { canReuseThread } from "../src/codex/service.js"

describe("Codex app-server thread selection", () => {
  test("starts fresh when no session is requested", () => {
    expect(canReuseThread("old-session", undefined)).toBe(false)
  })

  test("reuses only the explicitly requested current session", () => {
    expect(canReuseThread("current-session", "current-session")).toBe(true)
    expect(canReuseThread("current-session", "another-session")).toBe(false)
  })
})
