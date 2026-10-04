import fs from 'node:fs'
import readline from 'node:readline'

const out = process.argv[2]
const url = process.argv[3]
const log = (s) => fs.appendFileSync(out, s + '\n')
log(
  `MCP started pid=${process.pid} PROBE_VAR=${process.env.PROBE_VAR ?? '(unset)'} PLAYWRIGHT_MCP_CDP_ENDPOINT=${process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT ?? '(unset)'}`
)
try {
  const ws = new WebSocket(url)
  ws.onopen = () => ws.send('ping-from-mcp')
  ws.onmessage = (e) => log('MCP ws got ' + e.data)
  ws.onerror = (e) => log('MCP ws error ' + (e?.message ?? ''))
} catch (e) {
  log('MCP ws threw ' + e.message)
}
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.method === 'initialize')
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'probe', version: '0' }
        }
      }) + '\n'
    )
  else if (m.method === 'tools/list')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }) + '\n')
  else if (m.id !== undefined)
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n')
})
