const fs = require('node:fs')
const name = process.argv[2]
fs.appendFileSync('/tmp/mcp.log', `${name} started (cwd ${process.cwd()})\n`)
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id === undefined) continue
    const result =
      msg.method === 'initialize'
        ? {
            protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name, version: '1.0.0' }
          }
        : msg.method === 'tools/list'
          ? { tools: [] }
          : {}
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  }
})
