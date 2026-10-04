import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const base = fs.mkdtempSync(path.join(here, 'm-'))
const home = path.join(base, 'home')
const codexHome = path.join(base, 'codex')
const work = path.join(base, 'work')
for (const d of [home, codexHome, work]) fs.mkdirSync(d, { recursive: true })
const mcp = path.join(base, 'mcp.mjs')
fs.copyFileSync(path.join(here, 'mcp.mjs'), mcp)
const outFile = path.join(base, 'mcp-out.txt')

const seen = []
const server = http.createServer()
server.on('upgrade', (req, socket) => {
  const accept = crypto
    .createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
  )
  socket.on('data', (buf) => {
    const len = buf[1] & 0x7f
    const mask = buf.subarray(2, 6)
    seen.push(Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4])).toString())
    const reply = Buffer.from('pong-from-mac')
    socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]))
  })
})
await new Promise((r) => server.listen({ host: '127.0.0.1', port: 0 }, r))
const url = `ws://127.0.0.1:${server.address().port}`

fs.writeFileSync(
  path.join(codexHome, 'config.toml'),
  `[features]\napps = false\nplugins = false\n\n[projects.${JSON.stringify(fs.realpathSync(work))}]\ntrust_level = "trusted"\n\n[mcp_servers.probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(mcp)}, ${JSON.stringify(outFile)}, ${JSON.stringify(url)}]\n${process.argv[2] === 'envvars' ? 'env_vars = ["PLAYWRIGHT_MCP_CDP_ENDPOINT"]\n' : ''}`
)
console.log('variant:', process.argv[2] ?? 'plain')
const env = {
  HOME: home,
  CODEX_HOME: codexHome,
  PATH: process.env.PATH,
  PROBE_VAR: 'set-in-app-server-env',
  PLAYWRIGHT_MCP_CDP_ENDPOINT: url
}
console.log(
  spawnSync('codex', ['login', '--with-api-key'], { env, input: 'sk-dummy-not-a-real-key\n' })
    .stderr.toString()
    .trim()
)

const extra =
  process.argv[2] === 'cli'
    ? ['-c', 'mcp_servers.probe.env_vars=["PLAYWRIGHT_MCP_CDP_ENDPOINT"]']
    : []
console.log('app-server args:', JSON.stringify(['app-server', ...extra]))
const child = spawn('codex', ['app-server', ...extra], { env, cwd: work })
let frames = ''
child.stdout.on('data', (d) => (frames += d))
child.stderr.on('data', (d) => (frames += '[stderr] ' + d))
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n')
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'probe', version: '0' } } })
send({ method: 'initialized' })
send({
  id: 2,
  method: 'thread/start',
  params: { cwd: work, sandbox: 'workspace-write', approvalPolicy: 'on-request' }
})
await new Promise((r) => setTimeout(r, 12000))
child.kill()
server.close()
console.log('frames (first 1500 chars):', frames.slice(0, 1500))
console.log(
  '\nMCP log:\n' +
    (fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '(MCP never started)')
)
console.log('server saw:', JSON.stringify(seen))
process.exit(0)
