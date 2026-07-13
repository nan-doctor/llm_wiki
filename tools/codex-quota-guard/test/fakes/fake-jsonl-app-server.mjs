import readline from "node:readline"

process.stderr.write("Authorization: Bearer fake-secret token=fake-token cookie=fake-cookie\n")

const lines = readline.createInterface({ input: process.stdin })

process.stdout.write(`${JSON.stringify({
  method: "unknown/notification",
  params: { kept: true },
  extensionField: "preserved",
})}\n`)
process.stdout.write(`${JSON.stringify({
  id: "server-request-1",
  method: "unknown/serverRequest",
  params: { approval: "required" },
  extensionField: "preserved",
})}\n`)

lines.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "test/exit") {
    process.exit(7)
  }
  if (message.id === undefined) return
  process.stdout.write(`${JSON.stringify({
    id: message.id,
    result: {
      kept: message.params?.kept === true,
      args: process.argv.slice(2),
      remoteTokenVisible: Boolean(process.env.CODEX_QUOTA_GUARD_REMOTE_TOKEN),
    },
    extensionField: "preserved",
  })}\n`)
})
