import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const base = fs.mkdtempSync(path.join(here, 'p-'))
const home = path.join(base, 'home')
const codexHome = path.join(base, 'codex')
const work = path.join(base, 'work')
for (const d of [home, codexHome, work]) fs.mkdirSync(d, { recursive: true })
const client = path.join(base, 'client.mjs')
fs.copyFileSync(path.join(here, 'client.mjs'), client)

let seen = []
function wsServer(listenArg) {
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    socket.on('data', (buf) => {
      const len = buf[1] & 0x7f
      const mask = buf.subarray(2, 6)
      const payload = Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]))
      seen.push(payload.toString())
      const reply = Buffer.from('pong-from-mac')
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]))
    })
  })
  return new Promise((r) => server.listen(listenArg, () => r(server)))
}

const env = { HOME: home, CODEX_HOME: codexHome, PATH: process.env.PATH }
const node = process.execPath
const tcp = await wsServer({ host: '127.0.0.1', port: 0 })
const port = tcp.address().port
console.log(
  'codex',
  spawnSync('codex', ['--version'], { env }).stdout.toString().trim(),
  'node',
  process.version,
  new Date().toISOString()
)

function run(label, args, url) {
  seen = []
  return new Promise((resolve) => {
    const child = spawnSyncAsync(['sandbox', ...args, '--', node, client, url])
    child.then((r) => {
      console.log(
        `\n## ${label}\nexit=${r.status} out=${JSON.stringify(r.out.trim())} err=${JSON.stringify(r.err.trim().slice(0, 600))} serverSaw=${JSON.stringify(seen)}`
      )
      resolve()
    })
  })
}
import { spawn } from 'node:child_process'
function spawnSyncAsync(args) {
  return new Promise((resolve) => {
    const c = spawn('codex', args, { env, cwd: work })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (err += d))
    c.on('close', (status) => resolve({ status, out, err }))
  })
}

const tcpUrl = `ws://127.0.0.1:${port}`
await run('no sandbox flags (default config)', [], tcpUrl)
await run('workspace-write', ['-c', 'sandbox_mode="workspace-write"'], tcpUrl)
await run(
  'workspace-write + network_access=true',
  ['-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true'],
  tcpUrl
)
await run('read-only', ['-c', 'sandbox_mode="read-only"'], tcpUrl)
await run(
  'workspace-write --log-denials',
  ['-c', 'sandbox_mode="workspace-write"', '--log-denials'],
  tcpUrl
)
tcp.close()
process.exit(0)
