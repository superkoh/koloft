import { spawn, execFileSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { createRequire } from 'module'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const require = createRequire(path.join(HERE, '../../package.json'))
const WebSocket = require('ws')
const CODEX = process.argv[3] ?? 'codex'
const NODE = process.execPath
const root = fs.mkdtempSync(path.join(process.argv[2], 'p810-'))
const home = path.join(root, 'home')
const codexHome = path.join(home, '.codex')
const work = path.join(root, 'work')
const hookLog = path.join(root, 'hook.jsonl')
const mcpLog = path.join(root, 'mcp.jsonl')
for (const d of [codexHome, work]) fs.mkdirSync(d, { recursive: true })
const zdot = (name) => {
  const d = path.join(root, `z-${name}`)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, '.zshenv'), `export ZMARK=${name}\n`)
  return d
}
const log = (...a) => console.log(...a)

const CMD = 'echo "TAB=$PROBE_TAB ZD=${ZDOTDIR##*/} MARK=$ZMARK SERVER=$SERVER_TAG OWNER=$OWNER_VAR"'
let toolsSeen
let requests = 0
const fake = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    if (!req.url.endsWith('/responses')) {
      res.writeHead(404).end()
      return
    }
    requests++
    let r = {}
    try {
      r = JSON.parse(body)
    } catch {}
    const tools = (r.tools ?? []).map((t) => t.name ?? t.type)
    toolsSeen ??= tools
    const outs = (r.input ?? []).slice(-1).filter((i) => i.type === 'function_call_output')
    const send = (type, data) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const id = `resp_${requests}`
    send('response.created', { response: { id } })
    const item =
      outs.length || !tools.includes('exec_command')
        ? {
            type: 'message',
            role: 'assistant',
            id: `msg_${requests}`,
            content: [{ type: 'output_text', text: 'stand-in done' }]
          }
        : {
            type: 'function_call',
            name: 'exec_command',
            call_id: `call_${requests}`,
            arguments: JSON.stringify({ cmd: CMD })
          }
    send('response.output_item.done', { item })
    send('response.completed', {
      response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    })
    res.end()
  })
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const port = fake.address().port

fs.writeFileSync(
  path.join(codexHome, 'config.toml'),
  [
    'model = "gpt-5.5"',
    'model_provider = "stand-in"',
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    'check_for_update_on_startup = false',
    '[shell_environment_policy]',
    'set = { OWNER_VAR = "owner" }',
    '[features]',
    'apps = false',
    'plugins = false',
    '[mcp_servers.own]',
    `command = ${JSON.stringify(NODE)}`,
    `args = ${JSON.stringify([path.join(HERE, 'mcp.cjs'), mcpLog, 'owner-config'])}`,
    '[model_providers.stand-in]',
    'name = "stand-in"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    `[projects."${work}"]`,
    'trust_level = "trusted"',
    ''
  ].join('\n')
)
fs.writeFileSync(
  path.join(codexHome, 'auth.json'),
  JSON.stringify({ OPENAI_API_KEY: 'sk-not-a-real-key' })
)

const baseEnv = {
  HOME: home,
  CODEX_HOME: codexHome,
  PATH: `${path.dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  SHELL: '/bin/zsh',
  USER: process.env.USER,
  LOGNAME: process.env.USER,
  LANG: 'en_US.UTF-8',
  TMPDIR: process.env.TMPDIR
}
const serverConfig = [
  `hooks.PostToolUse=[{hooks=[{type="command",command=${JSON.stringify(`${NODE} ${path.join(HERE, 'hook.cjs')} ${hookLog}`)}}]}]`,
  `mcp_servers.srv.command=${JSON.stringify(NODE)}`,
  `mcp_servers.srv.args=${JSON.stringify([path.join(HERE, 'mcp.cjs'), mcpLog, 'server-level'])}`,
  'mcp_servers.srv.env_vars=["PROBE_TAB"]'
]

const servers = []
async function startServer(tag) {
  const sock = path.join(root, `${tag}.sock`)
  const child = spawn(
    CODEX,
    ['app-server', '--listen', `unix://${sock}`, ...serverConfig.flatMap((c) => ['-c', c])],
    {
      cwd: work,
      env: { ...baseEnv, SERVER_TAG: tag },
      detached: true,
      stdio: ['ignore', 'ignore', fs.openSync(path.join(root, `${tag}.log`), 'a')]
    }
  )
  servers.push(child)
  for (let i = 0; i < 200 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50))
  if (!fs.existsSync(sock)) throw new Error(`${tag} made no socket`)
  return { tag, sock, pid: child.pid, child }
}

async function connect(server, name) {
  const ws = new WebSocket(`ws+unix://${fs.realpathSync(server.sock)}:/`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let next = 0
  const pending = new Map()
  const notes = []
  const waiters = new Set()
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.method && m.id !== undefined) {
      ws.send(JSON.stringify({ id: m.id, error: { code: -32601, message: 'probe declines' } }))
      notes.push(m)
      return
    }
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) p.reject(new Error(`${p.method}: ${JSON.stringify(m.error)}`))
      else p.resolve(m.result)
      return
    }
    if (m.method) {
      notes.push(m)
      for (const w of [...waiters]) w(m)
    }
  })
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `${name}-${++next}`
      const t = setTimeout(() => reject(new Error(`${name} ${method} timed out`)), 30000)
      pending.set(id, {
        method,
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e))
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const waitFor = (pred, ms = 30000) =>
    new Promise((resolve, reject) => {
      const hit = notes.find(pred)
      if (hit) return resolve(hit)
      const t = setTimeout(() => {
        waiters.delete(w)
        reject(new Error(`${name} waited ${ms} ms in vain`))
      }, ms)
      const w = (m) => {
        if (!pred(m)) return
        clearTimeout(t)
        waiters.delete(w)
        resolve(m)
      }
      waiters.add(w)
    })
  await rpc('initialize', {
    clientInfo: { name: 'probe', title: 'probe', version: '1' },
    capabilities: { experimentalApi: true }
  })
  ws.send(JSON.stringify({ method: 'initialized' }))
  return { name, rpc, waitFor, notes, close: () => ws.close() }
}

const threadOf = (m) => m.params?.threadId ?? m.params?.thread?.id
async function runTurn(c, threadId) {
  const started = await c.rpc('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'go', text_elements: [] }]
  })
  const turnId = started?.turn?.id
  await c.waitFor((m) => m.method === 'turn/completed' && threadOf(m) === threadId)
  return c.notes
    .filter(
      (m) =>
        m.method === 'item/completed' &&
        threadOf(m) === threadId &&
        m.params.item?.type === 'commandExecution' &&
        (!turnId || m.params.turnId === turnId)
    )
    .map((m) => (m.params.item.aggregatedOutput ?? '').trim())
}

function treeRssMb(pid) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .map(([p, pp, rss, ...comm]) => ({ pid: +p, ppid: +pp, rss: +rss, comm: comm.join(' ') }))
  const inTree = new Set([pid])
  let grew = true
  while (grew) {
    grew = false
    for (const r of rows)
      if (!inTree.has(r.pid) && inTree.has(r.ppid)) {
        inTree.add(r.pid)
        grew = true
      }
  }
  const members = rows.filter((r) => inTree.has(r.pid))
  const codexOnly = members.filter((r) => r.comm.includes('codex'))
  const mb = (list) => (list.reduce((s, r) => s + r.rss, 0) / 1024).toFixed(1)
  return `${mb(codexOnly)} MB codex (${mb(members)} MB with ${members.length - codexOnly.length} other children)`
}

const startThread = async (c, config) =>
  (await c.rpc('thread/start', { cwd: work, ...(config && { config }) })).thread.id
const tabConfig = (tab, zd) => ({
  shell_environment_policy: { set: { PROBE_TAB: tab, ZDOTDIR: zd } },
  mcp_servers: {
    thr: { command: NODE, args: [path.join(HERE, 'mcp.cjs'), mcpLog, `thread-${tab}`], env: { MCP_TAB: tab } }
  }
})
const settle = () => new Promise((r) => setTimeout(r, 3000))

try {
  log(`codex ${execFileSync(CODEX, ['--version'], { encoding: 'utf8' }).trim()}`)
  const S = await startServer('S')
  const admin = await connect(S, 'admin')
  const listed = await admin.rpc('hooks/list', { cwds: [work] })
  const found = []
  JSON.stringify(listed, (k, v) => {
    if (v && typeof v === 'object' && v.currentHash && v.key) found.push(v)
    return v
  })
  for (const h of found)
    fs.appendFileSync(
      path.join(codexHome, 'config.toml'),
      `\n[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash = ${JSON.stringify(h.currentHash)}\n`
    )
  const relisted = []
  JSON.stringify(await admin.rpc('hooks/list', { cwds: [work] }), (k, v) => {
    if (v && typeof v === 'object' && v.currentHash && v.key) relisted.push(v.trustStatus)
    return v
  })
  log(`hooks trusted: ${relisted.join(',')}`)
  await settle()
  log(`\n[memory] S idle, no thread: ${treeRssMb(S.pid)}`)

  const cA = await connect(S, 'A')
  const cB = await connect(S, 'B')
  const zA = zdot('A')
  const zB = zdot('B')
  const A = await startThread(cA, tabConfig('A', zA))
  const B = await startThread(cB, tabConfig('B', zB))
  const [outA, outB] = await Promise.all([runTurn(cA, A), runTurn(cB, B)])
  log(`tools offered: ${toolsSeen?.join(',')}`)
  log(`\n[start] thread A (config A) ran: ${JSON.stringify(outA)}`)
  log(`[start] thread B (config B) ran: ${JSON.stringify(outB)}`)
  const leaked = (c, other) =>
    [...new Set(c.notes.filter((m) => threadOf(m) === other).map((m) => m.method))].join(',')
  log(`[connections] B's connection saw about A: ${leaked(cB, A) || 'nothing'}`)
  log(`[connections] A's connection saw about B: ${leaked(cA, B) || 'nothing'}`)
  log(`[connections] admin saw about A: ${leaked(admin, A) || 'nothing'}`)
  await settle()
  log(`\n[memory] S with 2 threads after a turn each: ${treeRssMb(S.pid)}`)

  const cC = await connect(S, 'C')
  const C = await startThread(cC)
  log(`[start] thread C (no config) ran: ${JSON.stringify(await runTurn(cC, C))}`)
  await settle()
  log(`[memory] S with 3 threads after a turn each: ${treeRssMb(S.pid)}`)

  const mcpBefore = fs.existsSync(mcpLog) ? fs.readFileSync(mcpLog, 'utf8').trim().split('\n').length : 0
  const cD = await connect(S, 'D')
  const D = await startThread(cD, {
    'shell_environment_policy.set.PROBE_TAB': 'D',
    'mcp_servers.thr': { command: NODE, args: [path.join(HERE, 'mcp.cjs'), mcpLog, 'thread-D-dotted'], env: { MCP_TAB: 'D' } }
  })
  log(`[start, dotted keys] thread D ran: ${JSON.stringify(await runTurn(cD, D))}`)
  await settle()
  const mcpAfter = fs.readFileSync(mcpLog, 'utf8').trim().split('\n').slice(mcpBefore)
  log(`[mcp started for thread D] ${mcpAfter.join(' | ')}`)

  const cA2 = await connect(S, 'A2')
  await cA2.rpc('thread/resume', { threadId: A, config: tabConfig('A-again', zdot('Aagain')) })
  log(`\n[resume, same server, thread still loaded, new config] A ran: ${JSON.stringify(await runTurn(cA2, A))}`)

  const singles = []
  for (const tag of ['T1', 'T2', 'T3']) {
    const T = await startServer(tag)
    const c = await connect(T, tag)
    const t = await startThread(c, tabConfig(tag, zdot(tag)))
    await runTurn(c, t)
    singles.push(T)
  }
  await settle()
  for (const T of singles) log(`[memory] ${T.tag}, its own server, 1 thread after a turn: ${treeRssMb(T.pid)}`)
  for (const T of singles) process.kill(-T.pid, 'SIGTERM')

  process.kill(-S.pid, 'SIGTERM')
  await new Promise((r) => setTimeout(r, 2000))
  fs.rmSync(S.sock, { force: true })
  const S2 = await startServer('S2')
  const r1 = await connect(S2, 'R1')
  await r1.rpc('thread/resume', { threadId: A, config: tabConfig('A-resumed', zdot('Aresumed')) })
  log(`\n[resume on a new server, new config] A ran: ${JSON.stringify(await runTurn(r1, A))}`)
  const r2 = await connect(S2, 'R2')
  await r2.rpc('thread/resume', { threadId: B })
  log(`[resume on a new server, no config] B ran: ${JSON.stringify(await runTurn(r2, B))}`)

  await settle()
  log(`\n[hooks] ${fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').trim() : 'none ran'}`)
  log(`thread ids: A=${A} B=${B} C=${C}`)
  log(`\n[mcp starts] ${fs.existsSync(mcpLog) ? fs.readFileSync(mcpLog, 'utf8').trim() : 'none'}`)
} catch (e) {
  log(`FAILED: ${e.stack}`)
} finally {
  for (const s of servers) {
    try {
      process.kill(-s.pid, 'SIGTERM')
    } catch {}
  }
  fake.close()
  setTimeout(() => process.exit(0), 1500)
}
