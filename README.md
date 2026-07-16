# goxt

A minimal terminal harness for the Codex CLI, built with OpenTUI and Effect.

## Requirements

- [Bun 1.3.13](https://bun.sh) (the version recorded in `package.json`)
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

The interface is exercised at 100 columns by 30 rows and is intended for terminals
around that size or larger. Its main panels shrink with the terminal, but very narrow
or short windows may clip picker descriptions, command suggestions, or status text.

Use `/model` to open a picker with the models available to the authenticated
Codex account. Use `/reasoning` to open a picker with the selected model's
supported reasoning levels. Move with the arrow keys, press Enter to select, or
Esc to cancel. Both settings apply to the next turn and remain active for later
turns. The direct `/model <id>` and `/reasoning <level>` forms also work;
`/help` shows the command summary.
Use `/usage` to fetch the current account rate limits and see the latest context
window details reported by Codex.
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
configuration requests them. Approval and input requests are shown in the composer;
if no turn is active, approvals are cancelled and user-input requests receive an empty
answer. Unknown reverse-request methods receive JSON-RPC `Method not found` errors.

Quitting destroys the terminal UI and disposes the Effect runtime. Scope cleanup closes
the app-server stdin pipe and sends `SIGTERM` to the child process; it does not wait for
an active turn to complete. `Esc` is the graceful way to interrupt only the current turn.

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

- `bun run dev` — run with watch mode
- `bun start` — run once
- `bun run check` — type-check
- `bun test` — run tests
- `bun run validate` — type-check and run tests
- `bun run protocol:verify` — generate bindings with the installed Codex CLI and
  verify that the checked-in slim snapshot still names the required protocol surface
- `bun run protocol:generate` — regenerate full bindings into the ignored
  `.protocol-snapshot/` directory for reviewing and manually updating the slim snapshot

Protocol verification is deliberately opt-in: ordinary tests use only the checked-in
snapshot and do not depend on whichever Codex CLI happens to be installed. After a Codex
upgrade, run `bun run protocol:generate`, reconcile the relevant types in
`src/codex/generated/protocol.ts`, update its source-version comment, and then run
`bun run protocol:verify` and `bun run validate`.
