# goxt

A minimal terminal harness for the Codex CLI, built with OpenTUI and Effect.

## Requirements

- [Bun](https://bun.sh)
- Codex CLI installed and authenticated (`codex login status`)

## Run

```sh
bun install
bun start
```

Type a prompt and press Enter. The harness starts one scoped
`codex app-server --stdio` process, initializes its JSON-RPC connection, and
streams the Codex thread into the UI. While a turn is active, type another prompt
to steer it. Press `Esc` to send `turn/interrupt` and `Ctrl+C` to quit.

Use `/model` to open a picker with the models available to the authenticated
Codex account. Use `/reasoning` to open a picker with the selected model's
supported reasoning levels. Move with the arrow keys, press Enter to select, or
Esc to cancel. Both settings apply to the next turn and remain active for later
turns. The direct `/model <id>` and `/reasoning <level>` forms also work;
`/help` shows the command summary.
Use `/clear` between turns to clear the transcript and start a new Codex thread;
the selected model and reasoning level remain unchanged. These settings are also
restored between launches from `~/.config/goxt/settings.json` (or
`$XDG_CONFIG_HOME/goxt/settings.json`).
Type `/` to see matching commands. Use the arrow keys to choose one, Tab to
complete it, or Enter to complete a partial command before running it.

The first prompt starts a persisted Codex thread; later prompts continue it on
the same app-server process. Turns use `workspace-write` and non-interactive
approvals, so start the harness only in a directory you intend to let Codex
inspect and edit. The client also handles app-server reverse requests for command
approval, file-change approval, and structured user input if the active Codex
configuration requests them.

## Architecture

- `src/codex/protocol.ts` — chunk-safe JSONL framing, request IDs, pending
  `Deferred`s, response/notification/reverse-request routing, and exit cleanup
- `src/codex/service.ts` — scoped child lifecycle, initialize, thread
  start/resume, turn start/steer/interrupt, and reverse-request responses
- `src/codex/event.ts` — schema-validated UI events with lossless unknown-event
  retention
- `src/codex/generated/` — slim protocol snapshot generated from the installed
  Codex CLI (`codex app-server generate-ts --experimental`)
- `src/ui/` — minimal OpenTUI view and theme
- `src/index.ts` — one persistent `ManagedRuntime` and OpenTUI callback wiring

## Commands

- `bun run check` — type-check
- `bun test` — run tests
