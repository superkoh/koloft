import { spawn, execFileSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { createRequire } from 'module'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const require = createRequire(path.join(HERE, '../../package.json'))
const WebSocket = require('ws')
const CODEX = process.argv[3] ?? 'codex'
const root = fs.mkdtempSync(path.join(process.argv[2], 'p810m-'))
const home = path.join(root, 'home')
const codexHome = path.join(home, '.codex')
const work = path.join(root, 'work')
for (const d of [codexHome, work]) fs.mkdirSync(d, { recursive: true })
const log = (...a) => console.log(...a)

let requests = 0
let spawnTool
const fake = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    requests++
    let r = {}
    try {
      r = JSON.parse(body)
    } catch {}
    const tools = r.tools ?? []
    spawnTool ??= tools.find((t) => /spawn/.test(t.name ?? ''))
    if (requests === 1) console.log(`tools: ${tools.map((t) => t.name ?? t.type).join(',')}`)
    const input = r.input ?? []
    const last = input.slice(-1)[0] ?? {}
    const text = JSON.stringify(input)
    const send = (type, data) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const id = `resp_${requests}`
    send('response.created', { response: { id } })
    const call = (name, args) => ({
      type: 'function_call',
      name,
      call_id: `call_${requests}`,
      arguments: JSON.stringify(args)
    })
    const say = { type: 'message', role: 'assistant', id: `msg_${requests}`, content: [{ type: 'output_text', text: 'done' }] }
    let item = say
    if (last.type !== 'function_call_output' && tools.some((t) => t.name === 'exec_command')) {
      if (text.includes('ASK-APPROVAL'))
        item = call('exec_command', {
          cmd: 'echo approved-run',
          sandbox_permissions: 'require_escalated',
          justification: 'probe'
        })
      else if (text.includes('CHILD-RUN'))
        item = call('exec_command', { cmd: 'echo "child PROBE_TAB=$PROBE_TAB" > child-env.txt' })
      else if (text.includes('PARENT-SPAWN') && spawnTool)
        item = call(spawnTool.name, { message: 'CHILD-RUN: run the command' })
    }
    send('response.output_item.done', { item })
    send('response.completed', { response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
    res.end()
  })
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
fs.writeFileSync(
  path.join(codexHome, 'config.toml'),
  [
    `model = "${process.argv[4] ?? 'gpt-5.5'}"`,
    'model_provider = "stand-in"',
    'sandbox_mode = "workspace-write"',
    'approval_policy = "on-request"',
    'check_for_update_on_startup = false',
    '[features]',
    'apps = false',
    'plugins = false',
    'multi_agent = true',
    '[model_providers.stand-in]',
    'name = "stand-in"',
    `base_url = "http://127.0.0.1:${fake.address().port}/v1"`,
    'wire_api = "responses"',
    `[projects."${work}"]`,
    'trust_level = "trusted"',
    ''
  ].join('\n')
)
fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-not-a-real-key' }))

const sock = path.join(root, 's.sock')
const server = spawn(CODEX, ['app-server', '--listen', `unix://${sock}`], {
  cwd: work,
  env: {
    HOME: home,
    CODEX_HOME: codexHome,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SHELL: '/bin/zsh',
    USER: process.env.USER,
    LANG: 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR
  },
  detached: true,
  stdio: ['ignore', 'ignore', fs.openSync(path.join(root, 's.log'), 'a')]
})
for (let i = 0; i < 200 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50))

async function connect(name) {
  const ws = new WebSocket(`ws+unix://${fs.realpathSync(sock)}:/`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let next = 0
  const pending = new Map()
  const notes = []
  const asked = []
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.method && m.id !== undefined) {
      asked.push(m)
      if (name === 'A') ws.send(JSON.stringify({ id: m.id, result: { decision: 'accept' } }))
      return
    }
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    } else if (m.method) notes.push(m)
  })
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `${name}-${++next}`
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  await rpc('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '1' }, capabilities: { experimentalApi: true } })
  ws.send(JSON.stringify({ method: 'initialized' }))
  const turnDone = (threadId, ms = 30000) =>
    new Promise((resolve) => {
      const until = Date.now() + ms
      const t = setInterval(() => {
        const hit = notes.some((m) => m.method === 'turn/completed' && m.params?.threadId === threadId)
        if (hit || Date.now() > until) {
          clearInterval(t)
          resolve(hit)
        }
      }, 100)
    })
  return { rpc, turnDone, notes, asked }
}
const turn = (c, threadId, text) =>
  c.rpc('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] })

try {
  log(`codex ${execFileSync(CODEX, ['--version'], { encoding: 'utf8' }).trim()}`)
  const a = await connect('A')
  const b = await connect('B')
  const A = (await a.rpc('thread/start', { cwd: work })).thread.id
  const B = (await b.rpc('thread/start', { cwd: work })).thread.id
  await turn(a, A, 'ASK-APPROVAL')
  log(`[approval] A's turn completed: ${await a.turnDone(A)}`)
  log(`[approval] server requests to A's connection: ${JSON.stringify(a.asked.map((m) => [m.method, m.params?.threadId === A ? 'thread A' : m.params?.threadId]))}`)
  log(`[approval] server requests to B's connection: ${JSON.stringify(b.asked.map((m) => [m.method, m.params?.threadId === A ? 'thread A' : m.params?.threadId]))}`)
  log(`[approval] B's connection notifications about A: ${[...new Set(b.notes.filter((m) => m.params?.threadId === A || m.params?.thread?.id === A).map((m) => m.method))].join(',')}`)
  log(`[approval] A's command output: ${JSON.stringify(a.notes.filter((m) => m.method === 'item/completed' && m.params.item?.type === 'commandExecution').map((m) => m.params.item.aggregatedOutput))}`)

  const c = await connect('C')
  const C = (
    await c.rpc('thread/start', {
      cwd: work,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: { 'shell_environment_policy.set.PROBE_TAB': 'C' }
    })
  ).thread.id
  await turn(c, C, 'PARENT-SPAWN')
  log(`\n[sub-agent] spawn tool offered: ${spawnTool ? `${spawnTool.name} ${JSON.stringify(spawnTool.parameters).slice(0, 300)}` : 'none'}`)
  log(`[sub-agent] parent turn completed: ${await c.turnDone(C, 40000)}`)
  for (let i = 0; i < 100 && !fs.existsSync(path.join(work, 'child-env.txt')); i++) await new Promise((r) => setTimeout(r, 100))
  log(`[sub-agent] child wrote: ${fs.existsSync(path.join(work, 'child-env.txt')) ? fs.readFileSync(path.join(work, 'child-env.txt'), 'utf8').trim() : 'nothing'}`)
  log(`[sub-agent] threads C's connection heard of: ${[...new Set(c.notes.map((m) => m.params?.threadId ?? m.params?.thread?.id).filter(Boolean))].length}`)
} catch (e) {
  log(`FAILED: ${e.stack}`)
} finally {
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch {}
  fake.close()
  setTimeout(() => process.exit(0), 1000)
}
