import readline from 'readline'
const rl = readline.createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
rl.on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.id === undefined) return
  if (m.method === 'initialize')
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '1' }
      }
    })
  else if (m.method === 'tools/list')
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        tools: [
          {
            name: 'ping',
            description: 'Answers pong.',
            inputSchema: { type: 'object', properties: {} }
          }
        ]
      }
    })
  else if (m.method === 'tools/call')
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } })
  else send({ jsonrpc: '2.0', id: m.id, result: {} })
})
