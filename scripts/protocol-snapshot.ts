import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const snapshot = join(root, "src/codex/generated/protocol.ts")
const generated = join(root, ".protocol-snapshot")

const requiredFiles = [
  "InitializeParams.ts", "InitializeResponse.ts", "RequestId.ts", "ServerNotification.ts",
  "ServerRequest.ts", "v2/ModelListParams.ts", "v2/ModelListResponse.ts",
  "v2/ThreadResumeParams.ts", "v2/ThreadStartParams.ts", "v2/ToolRequestUserInputResponse.ts",
  "v2/TurnInterruptParams.ts", "v2/TurnStartParams.ts", "v2/TurnSteerParams.ts",
] as const

const requiredMethods = [
  "account/rateLimits/read", "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval", "item/tool/requestUserInput", "model/list",
  "thread/resume", "thread/start", "turn/interrupt", "turn/start", "turn/steer",
] as const

const run = async (command: ReadonlyArray<string>) => {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}

const codexVersion = async () => {
  const child = Bun.spawn(["codex", "--version"], { stdout: "pipe", stderr: "inherit" })
  const output = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) process.exit(1)
  const match = output.trim().match(/^codex-cli\s+(\S+)$/)
  if (match?.[1] === undefined) throw new Error(`Unexpected Codex version output: ${output.trim()}`)
  return match[1]
}

const generate = async (out: string) => {
  await mkdir(out, { recursive: true })
  await run(["codex", "app-server", "generate-ts", "--experimental", "--out", out])
}

const verify = async () => {
  const out = await mkdtemp(join(tmpdir(), "goxt-protocol-"))
  try {
    await generate(out)
    const source = await readFile(snapshot, "utf8")
    const version = await codexVersion()
    if (!source.includes(`codex-cli ${version}.`)) {
      throw new Error(`Snapshot source version does not match installed codex-cli ${version}.`)
    }

    const missingFiles: Array<string> = []
    for (const file of requiredFiles) {
      try {
        await readFile(join(out, file), "utf8")
      } catch {
        missingFiles.push(file)
      }
    }

    const files = await readdir(out, { recursive: true })
    const generatedSource = (await Promise.all(
      files.filter((file) => file.endsWith(".ts")).map((file) => readFile(join(out, file), "utf8")),
    )).join("\n")
    const missingMethods = requiredMethods.filter((method) => !generatedSource.includes(`"${method}"`))
    if (missingFiles.length > 0 || missingMethods.length > 0) {
      const details = [
        ...missingFiles.map((file) => `missing generated type: ${file}`),
        ...missingMethods.map((method) => `missing method: ${method}`),
      ]
      throw new Error(`Protocol snapshot is stale:\n${details.join("\n")}`)
    }
    console.log(`Protocol snapshot matches codex-cli ${version} (${requiredMethods.length} methods checked).`)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
}

switch (process.argv[2]) {
  case "generate":
    await rm(generated, { recursive: true, force: true })
    await generate(generated)
    console.log(`Generated full bindings in ${relative(root, generated)}/.`)
    break
  case "verify":
    await verify()
    break
  default:
    throw new Error("Usage: protocol-snapshot.ts <generate|verify>")
}
