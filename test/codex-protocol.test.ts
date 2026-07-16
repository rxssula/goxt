import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { jsonLines, make, parseRpcMessage } from "../src/codex/protocol.js"

describe("Codex JSON-RPC protocol", () => {
  test("splits JSONL across arbitrary chunks", async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"id":1,"res'))
        controller.enqueue(encoder.encode('ult":{"ok":true}}\n{"method":"turn/'))
        controller.enqueue(encoder.encode('started","params":{"turn":{}}}\n'))
        controller.close()
      },
    })

    const lines: Array<string> = []
    for await (const line of jsonLines(stream)) lines.push(line)

    expect(lines).toEqual([
      '{"id":1,"result":{"ok":true}}',
      '{"method":"turn/started","params":{"turn":{}}}',
    ])
  })

  test("routes response, notification, and reverse-request shapes", async () => {
    const response = await Effect.runPromise(parseRpcMessage('{"id":1,"result":{"ok":true}}'))
    const notification = await Effect.runPromise(
      parseRpcMessage('{"method":"turn/started","params":{}}'),
    )
    const request = await Effect.runPromise(
      parseRpcMessage('{"id":"approval","method":"item/fileChange/requestApproval","params":{}}'),
    )

    expect(response).toEqual({ id: 1, result: { ok: true } })
    expect(notification).toEqual({ method: "turn/started", params: {} })
    expect(request).toEqual({
      id: "approval",
      method: "item/fileChange/requestApproval",
      params: {},
    })
  })

  test("fails requests made after the reader closes", async () => {
    const process = Bun.spawn(["bun", "-e", "process.stdout.end()"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* make(process)
          yield* Effect.flip(protocol.closed)
          return yield* Effect.exit(protocol.request("after/close", {}))
        }),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})
