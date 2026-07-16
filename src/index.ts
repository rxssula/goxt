import { createCliRenderer } from "@opentui/core"
import { Effect, ManagedRuntime } from "effect"
import type { ToolRequestUserInputResponse } from "./codex/generated/protocol.js"
import { CodexAppServer } from "./codex/service.js"
import type { ApprovalDecision } from "./codex/types.js"
import { HarnessView } from "./ui/harness-view.js"
import { loadSettings, saveSettings } from "./ui/settings.js"
import { theme } from "./ui/theme.js"

const cwd = process.cwd()
const initialSettings = await loadSettings()

const renderer = await createCliRenderer({
  screenMode: "alternate-screen",
  exitOnCtrlC: false,
  consoleMode: "disabled",
  openConsoleOnError: false,
  targetFps: 30,
  backgroundColor: theme.background,
  exitSignals: [],
})

const runtime = ManagedRuntime.make(CodexAppServer.layer)

const runWithCodex = <A, E>(effect: Effect.Effect<A, E, CodexAppServer.Service>) =>
  runtime.runPromise(effect)

interface ActiveTurn {
  interruptInFlight: boolean
}

let activeTurn: ActiveTurn | undefined
let quitting = false

const runAction = (effect: Effect.Effect<void, { readonly message: string }, CodexAppServer.Service>) =>
  void runWithCodex(
    effect.pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, message: error.message }),
        onSuccess: () => ({ ok: true as const }),
      }),
    ),
  )
    .then((result) => {
      if (!result.ok && !quitting) view.actionFailed(result.message)
    })
    .catch(() => {
      if (!quitting) view.actionFailed("The Codex app-server action stopped unexpectedly.")
    })

const respondApproval = (requestId: number | string, decision: ApprovalDecision) =>
  runWithCodex(
    Effect.gen(function* () {
      const codex = yield* CodexAppServer.Service
      yield* codex.respondApproval(requestId, decision)
    }),
  )

const respondUserInput = (requestId: number | string, response: ToolRequestUserInputResponse) =>
  runWithCodex(
    Effect.gen(function* () {
      const codex = yield* CodexAppServer.Service
      yield* codex.respondUserInput(requestId, response)
    }),
  )

const view = new HarnessView(renderer, cwd, {
  onSubmit: (prompt, settings) => {
    if (activeTurn !== undefined) return

    const turn: ActiveTurn = { interruptInFlight: false }
    activeTurn = turn
    view.begin(prompt)

    const run = Effect.gen(function* () {
      const codex = yield* CodexAppServer.Service
      const sessionId = view.currentSessionId
      return yield* codex.run(
        sessionId === undefined
          ? { prompt, cwd, ...settings }
          : { prompt, cwd, sessionId, ...settings },
        (event) => view.handleEvent(event),
      )
    }).pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, message: error.message }),
        onSuccess: (status) => ({ ok: true as const, status }),
      }),
    )

    void runWithCodex(run)
      .then((result) => {
        if (quitting) return
        if (result.ok) {
          if (result.status === "interrupted") view.interrupted()
          else view.complete()
        } else view.fail(result.message)
      })
      .catch(() => {
        if (!quitting) view.fail("The Codex app-server turn stopped unexpectedly.")
      })
      .finally(() => {
        if (activeTurn === turn) activeTurn = undefined
      })
  },
  onSettingsChange: (settings) => {
    void saveSettings(settings)
  },
  onSteer: (prompt) => {
    runAction(
      Effect.gen(function* () {
        const codex = yield* CodexAppServer.Service
        yield* codex.steer(prompt)
      }),
    )
  },
  onInterrupt: () => {
    const turn = activeTurn
    if (turn === undefined || turn.interruptInFlight) return
    turn.interruptInFlight = true
    view.interrupting()
    const interrupt = Effect.gen(function* () {
      const codex = yield* CodexAppServer.Service
      yield* codex.interrupt()
    })
    void runWithCodex(interrupt).catch((error: unknown) => {
      turn.interruptInFlight = false
      if (!quitting && activeTurn === turn) {
        view.actionFailed(error instanceof Error ? error.message : "Could not interrupt the turn.")
      }
    })
  },
  onApproval: respondApproval,
  onUserInput: respondUserInput,
  onUsage: () => {
    const loadUsage = Effect.gen(function* () {
      const codex = yield* CodexAppServer.Service
      return yield* codex.readRateLimits()
    })
    void runWithCodex(loadUsage)
      .then((rateLimits) => view.showUsage(rateLimits))
      .catch((error: unknown) => {
        if (quitting) return
        view.usageFailed(error instanceof Error ? error.message : "Could not read current usage.")
      })
  },
  onQuit: () => {
    void shutdown()
  },
}, initialSettings)

let shutdownPromise: Promise<void> | undefined
const shutdown = (): Promise<void> => {
  if (shutdownPromise !== undefined) return shutdownPromise
  quitting = true
  view.destroy()
  shutdownPromise = runtime.dispose().catch(() => {
    // Shutdown is best-effort after the terminal has been restored.
  })
  return shutdownPromise
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    void shutdown()
  })
}

const loadStatus = Effect.gen(function* () {
  const codex = yield* CodexAppServer.Service
  return yield* codex.status()
})

void runWithCodex(loadStatus)
  .then((status) => view.setCodexStatus(status))
  .catch(() =>
    view.setCodexStatus({
      available: false,
      authenticated: false,
      version: "unknown",
    }),
  )

const loadModels = Effect.gen(function* () {
  const codex = yield* CodexAppServer.Service
  return yield* codex.listModels()
})

void runWithCodex(loadModels)
  .then((models) => view.setModels(models))
  .catch(() => {
    // The rest of the harness remains usable if model discovery is unavailable.
  })
