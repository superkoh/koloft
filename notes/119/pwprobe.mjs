import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const [, , repo, pwmcpCli, codexBin] = process.argv
const req = createRequire(path.join(repo, 'package.json'))
const { WebSocketServer, WebSocket } = req('ws')
const { chromium } = req('@playwright/test')

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pw119-'))
const home = path.join(base, 'home')
const codexHome = path.join(base, 'codex')
const work = path.join(base, 'work')
const chromeData = path.join(base, 'chrome')
for (const d of [home, codexHome, work, chromeData]) fs.mkdirSync(d, { recursive: true })
const log = (...a) => console.log(...a)

const ctx = await chromium.launchPersistentContext(chromeData, {
  channel: 'chrome',
  headless: true,
  args: ['--remote-debugging-port=0']
})
const portLine = fs.readFileSync(path.join(chromeData, 'DevToolsActivePort'), 'utf8').split('\n')
const chromeWs = `ws://127.0.0.1:${portLine[0]}${portLine[1]}`

let open = 0
let current = null
const attempts = []
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
wss.on('connection', (client, r) => {
  attempts.push({ at: Date.now(), concurrentBefore: open, path: r.url })
  if (open > 0) {
    client.close(1008, 'this endpoint already has a client')
    return
  }
  open++
  current = client
  const up = new WebSocket(chromeWs, { perMessageDeflate: false })
  const queue = []
  up.on('open', () => queue.splice(0).forEach((m) => up.send(m)))
  client.on('message', (m) => (up.readyState === 1 ? up.send(String(m)) : queue.push(String(m))))
  up.on('message', (m) => client.readyState === 1 && client.send(String(m)))
  const end = () => {
    if (client._counted) return
    client._counted = true
    open--
    up.close()
    client.close()
  }
  client.on('close', end)
  up.on('close', end)
})
await new Promise((r) => wss.on('listening', r))
const endpoint = `ws://127.0.0.1:${wss.address().port}/cdp/${'a'.repeat(32)}`
log('stand-in endpoint:', endpoint)

fs.writeFileSync(
  path.join(codexHome, 'config.toml'),
  `[features]\napps = false\nplugins = false\n\n[projects.${JSON.stringify(fs.realpathSync(work))}]\ntrust_level = "trusted"\n\n[mcp_servers.playwright]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(pwmcpCli)}, "--headless"]\nenv_vars = ["OWNER_VAR"]\n\n[mcp_servers.other]\ncommand = "/bin/cat"\n`
)
const env = {
  HOME: home,
  CODEX_HOME: codexHome,
  PATH: process.env.PATH,
  OWNER_VAR: 'owner',
  PLAYWRIGHT_MCP_CDP_ENDPOINT: endpoint,
  PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: '1'
}
spawnSync(codexBin, ['login', '--with-api-key'], { env, input: 'sk-dummy-not-a-real-key\n' })

function appServer(extra) {
  const child = spawn(codexBin, ['app-server', '--stdio', ...extra], { env, cwd: work })
  let buf = ''
  const waiters = new Map()
  const notes = []
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const m = JSON.parse(line)
      if (m.id !== undefined && waiters.has(m.id)) {
        waiters.get(m.id)(m)
        waiters.delete(m.id)
      } else if (m.method) notes.push(m)
    }
  })
  child.stderr.on('data', () => {})
  let id = 0
  const call = (method, params) =>
    new Promise((resolve) => {
      const n = ++id
      waiters.set(n, resolve)
      child.stdin.write(JSON.stringify({ id: n, method, params }) + '\n')
    })
  return { child, call, notes }
}

function mcpProcesses(rootPid) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }))
  const mine = new Set([rootPid])
  let grew = true
  while (grew) {
    grew = false
    for (const r of rows)
      if (mine.has(r.ppid) && !mine.has(r.pid)) {
        mine.add(r.pid)
        grew = true
      }
  }
  return rows.filter((r) => mine.has(r.pid) && r.cmd.includes(pwmcpCli)).map((r) => r.pid)
}

const t0 = Date.now()
const timing = appServer([])
await timing.call('initialize', { clientInfo: { name: 'probe', version: '0' } })
timing.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
const read = await timing.call('config/read', { cwd: work })
log('config/read on a fresh app-server took', Date.now() - t0, 'ms')
log('config/read mcp_servers:', JSON.stringify(read.result?.config?.mcp_servers ?? read))
timing.child.kill()

const list = read.result.config.mcp_servers.playwright.env_vars ?? []
const override = `mcp_servers.playwright.env_vars=${JSON.stringify([...list, 'PLAYWRIGHT_MCP_CDP_ENDPOINT', 'PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS'])}`
log('override:', override)
const s = appServer(['-c', override])
await s.call('initialize', { clientInfo: { name: 'probe', version: '0' } })
s.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
const reread = await s.call('config/read', { cwd: work })
log('config/read with the override:', JSON.stringify(reread.result.config.mcp_servers.playwright))

const a = await s.call('thread/start', {
  cwd: work,
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request'
})
const threadA = a.result?.thread?.id
log('thread A', threadA)
await new Promise((r) => setTimeout(r, 4000))
log('MCP processes after thread A:', JSON.stringify(mcpProcesses(s.child.pid)))
const navA = await s.call('mcpServer/tool/call', {
  server: 'playwright',
  threadId: threadA,
  tool: 'browser_navigate',
  arguments: { url: 'data:text/html,<title>from-thread-A</title>' }
})
log('thread A browser_navigate:', JSON.stringify(navA).slice(0, 400))
log('CDP connection attempts so far:', JSON.stringify(attempts))

const b = await s.call('thread/start', {
  cwd: work,
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request'
})
const threadB = b.result?.thread?.id
log('thread B', threadB)
await new Promise((r) => setTimeout(r, 4000))
log('MCP processes after thread B:', JSON.stringify(mcpProcesses(s.child.pid)))
if (process.argv[5] === 'drop') {
  current.close(1008, 'a new session took over this tab')
  await new Promise((r) => setTimeout(r, 500))
  log('dropped thread A client; open CDP connections:', open)
}
if (process.argv[5] === 'unsubscribe') {
  const u = await s.call('thread/unsubscribe', { threadId: threadA })
  log('thread/unsubscribe A:', JSON.stringify(u))
  const since = Date.now()
  const waitMs = Number(process.argv[6] ?? 3000)
  while (Date.now() - since < waitMs) {
    await new Promise((r) => setTimeout(r, 2000))
    const left = mcpProcesses(s.child.pid)
    if (left.length < 2) break
  }
  log(
    `MCP processes ${Date.now() - since} ms after unsubscribing A:`,
    JSON.stringify(mcpProcesses(s.child.pid))
  )
  log('open CDP connections after unsubscribing A:', open)
}
const navB = await s.call('mcpServer/tool/call', {
  server: 'playwright',
  threadId: threadB,
  tool: 'browser_navigate',
  arguments: { url: 'data:text/html,<title>from-thread-B</title>' }
})
log('thread B browser_navigate:', JSON.stringify(navB).slice(0, 400))
log('CDP connection attempts so far:', JSON.stringify(attempts))
log('pages Chrome holds:', JSON.stringify(await Promise.all(ctx.pages().map((p) => p.title()))))

const notes = s.notes.filter((n) => /mcp/i.test(n.method)).map((n) => n.method)
log('mcp notifications:', JSON.stringify([...new Set(notes)]))
s.child.kill()
await ctx.close()
wss.close()
fs.rmSync(base, { recursive: true, force: true })
process.exit(0)
