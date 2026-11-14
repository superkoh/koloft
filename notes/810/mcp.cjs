const fs = require('fs')
const readline = require('readline')
fs.appendFileSync(
  process.argv[2],
  JSON.stringify({
    mcp: process.argv[3],
    pid: process.pid,
    PROBE_TAB: process.env.PROBE_TAB ?? null,
    MCP_TAB: process.env.MCP_TAB ?? null
  }) + '\n'
)
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.id === undefined) return
  if (m.method === 'initialize')
    reply(m.id, {
      protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'probe', version: '1' }
    })
  else if (m.method === 'tools/list') reply(m.id, { tools: [] })
  else reply(m.id, {})
})
