import { describe, expect, test } from "bun:test"
import { parseSlashCommand, suggestSlashCommands } from "../src/ui/slash-command.js"

describe("slash commands", () => {
  test("parses model and reasoning selections", () => {
    expect(parseSlashCommand("/model gpt-5.6-sol")).toEqual({
      _tag: "Model",
      value: "gpt-5.6-sol",
    })
    expect(parseSlashCommand("  /REASONING   high  ")).toEqual({
      _tag: "Reasoning",
      value: "high",
    })
  })

  test("distinguishes listings, help, unknown commands, and prompts", () => {
    expect(parseSlashCommand("/clear")).toEqual({ _tag: "Clear" })
    expect(parseSlashCommand("/model")).toEqual({ _tag: "Model" })
    expect(parseSlashCommand("/help")).toEqual({ _tag: "Help" })
    expect(parseSlashCommand("/compact")).toEqual({ _tag: "Unknown", name: "compact" })
    expect(parseSlashCommand("Inspect /model handling")).toBeUndefined()
  })

  test("suggests slash commands from a command prefix", () => {
    expect(suggestSlashCommands("/").map((command) => command.name)).toEqual([
      "help",
      "model",
      "reasoning",
      "clear",
    ])
    expect(suggestSlashCommands("/M").map((command) => command.name)).toEqual(["model"])
    expect(suggestSlashCommands("/reasoning ")).toEqual([])
    expect(suggestSlashCommands("Ask /model")).toEqual([])
  })
})
