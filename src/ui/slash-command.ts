export type SlashCommand =
  | { readonly _tag: "Clear" }
  | { readonly _tag: "Model"; readonly value?: string }
  | { readonly _tag: "Reasoning"; readonly value?: string }
  | { readonly _tag: "Help" }
  | { readonly _tag: "Unknown"; readonly name: string }

export interface SlashCommandSuggestion {
  readonly name: string
  readonly description: string
}

export const slashCommandSuggestions: ReadonlyArray<SlashCommandSuggestion> = [
  { name: "help", description: "Show available slash commands" },
  { name: "model", description: "Choose the model for future turns" },
  { name: "reasoning", description: "Choose the reasoning effort" },
  { name: "clear", description: "Start a new session and clear the screen" },
]

export const suggestSlashCommands = (input: string): ReadonlyArray<SlashCommandSuggestion> => {
  if (!input.startsWith("/") || /\s/.test(input)) return []
  const prefix = input.slice(1).toLowerCase()
  return slashCommandSuggestions.filter((command) => command.name.startsWith(prefix))
}

export const parseSlashCommand = (input: string): SlashCommand | undefined => {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return undefined

  const separator = trimmed.search(/\s/)
  const name = (separator === -1 ? trimmed.slice(1) : trimmed.slice(1, separator)).toLowerCase()
  const value = separator === -1 ? undefined : trimmed.slice(separator).trim() || undefined

  switch (name) {
    case "clear":
      return { _tag: "Clear" }
    case "model":
      return { _tag: "Model", ...(value === undefined ? {} : { value }) }
    case "reasoning":
      return { _tag: "Reasoning", ...(value === undefined ? {} : { value }) }
    case "help":
      return { _tag: "Help" }
    default:
      return { _tag: "Unknown", name: name || "/" }
  }
}
