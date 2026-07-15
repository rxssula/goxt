import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { CodexTurnSettings } from "../codex/types.js"

export interface PersistedSettings {
  readonly model?: string
  readonly reasoningEffort?: string
}

const settingsPath = (): string | undefined => {
  const configHome = Bun.env.XDG_CONFIG_HOME ?? (Bun.env.HOME ? `${Bun.env.HOME}/.config` : undefined)
  return configHome === undefined ? undefined : `${configHome}/goxt/settings.json`
}

export const loadSettings = async (): Promise<PersistedSettings> => {
  const path = settingsPath()
  if (path === undefined) return {}

  try {
    const value: unknown = JSON.parse(await Bun.file(path).text())
    if (typeof value !== "object" || value === null) return {}

    const record = value as Record<string, unknown>
    const model = typeof record.model === "string" ? record.model : undefined
    const reasoningEffort =
      typeof record.reasoningEffort === "string" ? record.reasoningEffort : undefined
    return {
      ...(model === undefined ? {} : { model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
  } catch {
    return {}
  }
}

export const saveSettings = async (settings: CodexTurnSettings): Promise<void> => {
  const path = settingsPath()
  if (path === undefined) return

  try {
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(
      path,
      JSON.stringify(
        {
          ...(typeof settings.model === "string" ? { model: settings.model } : {}),
          ...(typeof settings.reasoningEffort === "string"
            ? { reasoningEffort: settings.reasoningEffort }
            : {}),
        },
        null,
        2,
      ) + "\n",
    )
  } catch {
    // Settings are a convenience; an unavailable config directory must not
    // prevent the harness from starting or sending turns.
  }
}
