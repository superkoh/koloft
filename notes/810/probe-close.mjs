import { spawn, execFileSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { createRequire } from 'module'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const require = createRequire(path.join(HERE, '../../package.json'))
const WebSocket = require('ws')
const CODEX = process.argv[3] ?? 'codex'
const root = fs.mkdtempSync(path.join(process.argv[2], 'p810c-'))
const home = path.join(root, 'home')
const codexHome = path.join(home, '.codex')
const work = path.join(root, 'work')
for (const d of [codexHome, work]) fs.mkdirSync(d, { recursive: true })
const log = (...a) => console.log(...a)
const marker = path.basename(root)

let requests = 0
const fake = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    requests++
    let r = {}
    try {
      r = JSON.parse(body)
    } catch {}
    const last = (r.input ?? []).slice(-1)[0] ?? {}
    const userText = JSON.stringify((r.input ?? []).filter((i) => i.role === 'user').slice(-1))
    const tab = /TAB-([A-Z])/.exec(userText)?.[1] ?? 'X'
    const send = (type, data) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const id = `resp_${requests}`
    send('response.created', { response: { id } })
    const item =
      last.type === 'function_call_output' || !(r.tools ?? []).some((t) => t.name === 'exec_command')
        ? { type: 'message', role: 'assistant', id: `msg_${requests}`, content: [{ type: 'output_text', text: 'left it running' }] }
        : {
            type: 'function_call',
            name: 'exec_command',
            call_id: `call_${requests}`,
            arguments: JSON.stringify({
              cmd: `sleep 45 && touch ${marker}-done-${tab}`,
              yield_time_ms: 500
            })
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
    'model = "gpt-5.5"',
    'model_provider = "stand-in"',
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    'check_for_update_on_startup = false',
    '[features]',
    'apps = false',
    'plugins = false',
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
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.id !== undefined && !m.method && pending.has(m.id)) {
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
  const turnDone = (threadId) =>
    new Promise((resolve) => {
      const t = setInterval(() => {
        if (notes.some((m) => m.method === 'turn/completed' && m.params?.threadId === threadId)) {
          clearInterval(t)
          resolve()
        }
      }, 100)
    })
  return { rpc, turnDone, close: () => ws.close() }
}

const alive = (tab) => {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', `${marker}-done-${tab}`], { encoding: 'utf8' }).trim().split('\n').length
  } catch {
    return 0
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  log(`codex ${execFileSync(CODEX, ['--version'], { encoding: 'utf8' }).trim()}`)
  const a = await connect('A')
  const b = await connect('B')
  const A = (await a.rpc('thread/start', { cwd: work })).thread.id
  const B = (await b.rpc('thread/start', { cwd: work })).thread.id
  for (const [c, t, tab] of [[a, A, 'A'], [b, B, 'B']]) {
    await c.rpc('turn/start', { threadId: t, input: [{ type: 'text', text: `TAB-${tab}`, text_elements: [] }] })
    await c.turnDone(t)
  }
  log(`after both turns ended: A's sleep processes ${alive('A')}, B's ${alive('B')}`)
  log(`A list: ${JSON.stringify(await a.rpc('thread/backgroundTerminals/list', { threadId: A }))}`)
  log(`A clean: ${JSON.stringify(await a.rpc('thread/backgroundTerminals/clean', { threadId: A }))}`)
  await wait(2000)
  log(`2 s after clean of A: A's ${alive('A')}, B's ${alive('B')}`)
  log(`B unsubscribe: ${JSON.stringify(await b.rpc('thread/unsubscribe', { threadId: B }))}`)
  b.close()
  await wait(5000)
  log(`5 s after B unsubscribed and closed its connection: B's ${alive('B')}`)
  await wait(50000)
  log(`55 s after: B's ${alive('B')}, B's file written: ${fs.existsSync(path.join(work, `${marker}-done-B`))}, A's file written: ${fs.existsSync(path.join(work, `${marker}-done-A`))}`)
} catch (e) {
  log(`FAILED: ${e.stack}`)
} finally {
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch {}
  fake.close()
  setTimeout(() => process.exit(0), 1000)
}
