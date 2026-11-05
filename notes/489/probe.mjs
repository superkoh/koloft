import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { WebSocketServer } = require('ws')
const here = path.dirname(fileURLToPath(import.meta.url))

const [lab, kase, codex, port] = process.argv.slice(2)
const { repo, home, codexHome } = JSON.parse(fs.readFileSync(path.join(lab, 'lab.json'), 'utf8'))
const outDir = path.join(lab, 'out', kase)
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
const env = { ...process.env, HOME: home, CODEX_HOME: codexHome }
for (const k of Object.keys(env)) if (k.startsWith('KOLOFT_')) delete env[k]
const extra = [
  ...(kase.includes('disable') ? ['--disable', 'worktrees'] : []),
  ...(kase.includes('flag') ? ['--worktree'] : [])
]
const wantsTool = kase.includes('tool') || kase.includes('disable')

const modelLog = []
const toolNames = (tools) =>
  (tools ?? []).flatMap((t) =>
    t.type === 'namespace'
      ? (t.tools ?? []).map((i) => ({ namespace: t.name, name: i.name, params: i.parameters }))
      : [
          {
            type: t.type,
            name: t.name,
            params: t.name?.includes('worktree') ? t.parameters : undefined,
            description: t.type === 'tool_search' ? t.description : undefined
          }
        ]
  )
const findTool = (tools, name) => toolNames(tools).find((t) => t.name?.endsWith(name))
let n = 0
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (d) => chunks.push(d))
  req.on('end', () => {
    let buf = Buffer.concat(chunks)
    const enc = req.headers['content-encoding']
    if (enc === 'zstd') buf = zlib.zstdDecompressSync(buf)
    if (enc === 'gzip') buf = zlib.gunzipSync(buf)
    if (!req.url.endsWith('/responses')) {
      modelLog.push({ url: req.url, method: req.method })
      res.writeHead(404).end()
      return
    }
    let request = {}
    try {
      request = JSON.parse(buf.toString())
    } catch {}
    const outputs = (request.input ?? []).filter((i) => i.type?.endsWith('_call_output'))
    const searchable = JSON.stringify(request.tools ?? []).includes('codex_worktrees')
    const searched = (request.input ?? []).filter((i) => i.type === 'tool_search_output')
    const loaded = [...(request.tools ?? []), ...searched.flatMap((s) => s.tools ?? [])]
    const create = findTool(loaded, 'create_worktree')
    const status = findTool(loaded, 'get_worktree_creation_status')
    modelLog.push({
      url: req.url,
      encoding: enc,
      bytes: buf.length,
      keys: Object.keys(request),
      model: request.model,
      tools: toolNames(request.tools),
      searched,
      outputs,
      calls: (request.input ?? []).filter((i) => i.type?.endsWith('_call'))
    })
    const send = (type, data) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const id = `resp_${++n}`
    send('response.created', { response: { id } })
    const call = (tool, args) => ({
      type: 'function_call',
      name: tool.name,
      ...(tool.namespace && { namespace: tool.namespace }),
      call_id: `call_${n}`,
      arguments: JSON.stringify(args)
    })
    let item
    const last = outputs.at(-1)
    const lastText = last ? JSON.stringify(last.output) : ''
    const opId = lastText.match(/operationId\\?"\s*:\s*\\?"([^"\\]+)/)?.[1]
    if (wantsTool && !create && searchable && !searched.length)
      item = {
        type: 'tool_search_call',
        call_id: `search_${n}`,
        execution: 'client',
        status: 'completed',
        arguments: { query: 'create worktree', limit: 5 }
      }
    else if (wantsTool && create && outputs.length === 0) item = call(create, { allowAsync: true })
    else if (
      wantsTool &&
      status &&
      opId &&
      outputs.length < 6 &&
      !/ready|complete|succeeded|failed|error/i.test(lastText.replace(/operationId[^,]*/, ''))
    )
      item = call(status, { operationId: opId })
    else if (wantsTool && status && opId && outputs.length === 1)
      item = call(status, { operationId: opId })
    else
      item = {
        type: 'message',
        role: 'assistant',
        id: `msg_${n}`,
        content: [{ type: 'output_text', text: `fake model done ${n}` }]
      }
    if (outputs.length && item.type === 'function_call') {
      const wait = Date.now() + 1500
      while (Date.now() < wait);
    }
    send('response.output_item.done', { item })
    send('response.completed', {
      response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    })
    res.end()
  })
})
await new Promise((r) => server.listen(Number(port), '127.0.0.1', r))

const frames = []
let relay
const sock = `/tmp/cx489-${kase}.sock`
if (kase.startsWith('remote') && kase.includes('listen')) {
  fs.rmSync(sock, { force: true })
  const appServer = spawn(codex, ['app-server', '--listen', `unix://${sock}`], {
    cwd: home,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  appServer.stderr.on('data', (d) => (stderr += d))
  appServer.stdout.on('data', (d) => (stderr += d))
  const until = Date.now() + 15000
  while (!fs.existsSync(sock) && Date.now() < until) await new Promise((r) => setTimeout(r, 200))
  relay = { appServer, httpSrv: { close() {} }, stderr: () => stderr }
} else if (kase.startsWith('remote')) {
  fs.rmSync(sock, { force: true })
  const appServer = spawn(codex, ['app-server', ...extra.filter((a) => a !== '--worktree')], {
    cwd: home,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  appServer.stderr.on('data', (d) => (stderr += d))
  const wss = new WebSocketServer({ noServer: true })
  const httpSrv = http.createServer()
  httpSrv.on('upgrade', (req, socket, head) =>
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
  )
  wss.on('connection', (ws) => {
    let pending = ''
    appServer.stdout.on('data', (d) => {
      pending += d
      let i
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i)
        pending = pending.slice(i + 1)
        if (!line.trim()) continue
        frames.push({ t: Date.now(), dir: 'server', frame: safeParse(line) })
        ws.send(line)
      }
    })
    ws.on('message', (data) => {
      const line = data.toString()
      frames.push({ t: Date.now(), dir: 'client', frame: safeParse(line) })
      appServer.stdin.write(line + '\n')
    })
  })
  await new Promise((r) => httpSrv.listen(sock, r))
  relay = { appServer, httpSrv, stderr: () => stderr }
}

function safeParse(line) {
  try {
    return JSON.parse(line)
  } catch {
    return line
  }
}

const tuiArgs = kase.startsWith('remote')
  ? ['--remote', `unix://${sock}`, '-C', repo, ...extra]
  : ['--no-daemon', '-C', repo, ...extra]
const keepModel = [
  { until: 'Use existing model', timeout: 15 },
  { send: '\x1b[B' },
  { send: '\r' },
  { wait: 3 }
]
let steps
if (kase.includes('fork'))
  steps = [
    ...keepModel,
    { wait: 3 },
    { send: 'Say hi.' },
    { wait: 1 },
    { send: '\r' },
    { until: 'fake model done', timeout: 60 },
    { wait: 3 },
    { mark: 'typing /fork' },
    { send: '/fork' },
    { wait: 1.5 },
    { send: '\r' },
    { wait: 6 }
  ]
else if (kase.includes('new'))
  steps = [
    ...keepModel,
    { wait: 4 },
    { mark: 'typing /new' },
    { send: '/new' },
    { wait: 1.5 },
    { send: '\r' },
    { wait: 6 }
  ]
else if (wantsTool)
  steps = [
    ...keepModel,
    { wait: 3 },
    { send: 'Make a new worktree for this task.' },
    { wait: 1 },
    { send: '\r' },
    { until: 'fake model done', timeout: 90 },
    { wait: 4 }
  ]
else steps = [{ wait: 10 }]

let execOut = ''
if (kase.startsWith('exec')) {
  const r = spawn(codex, ['exec', '--worktree', '-C', repo, ...extra, 'say hi'], {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  r.stdout.on('data', (d) => (execOut += d))
  r.stderr.on('data', (d) => (execOut += d))
  await new Promise((res) => r.on('exit', (code) => res((execOut += `\n[exit ${code}]\n`))))
} else {
  const py = spawn(
    'python3',
    [
      path.join(here, 'drive-tui.py'),
      JSON.stringify([codex, ...tuiArgs]),
      JSON.stringify(steps),
      path.join(outDir, 'screen')
    ],
    { env, cwd: repo, stdio: 'inherit' }
  )
  await new Promise((r) => py.on('exit', r))
}

const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo }).toString()
const found = execFileSync(
  'find',
  [home, codexHome, '-maxdepth', '4', '-type', 'd', '-path', '*worktree*'],
  { encoding: 'utf8' }
)

if (relay) {
  relay.appServer.kill()
  relay.httpSrv.close()
}
server.close()

const realLab = fs.realpathSync(lab)
const scrub = (s) =>
  s
    .split(realLab)
    .join('<lab>')
    .split(lab)
    .join('<lab>')
    .replace(/\/(private\/)?tmp\/claude-\S*/g, '<lab path>')
    .replace(/\S*Users-\S*/g, '<lab path>')
const write = (name, value) =>
  fs.writeFileSync(
    path.join(outDir, name),
    scrub(typeof value === 'string' ? value : JSON.stringify(value, null, 1))
  )
write('model.json', modelLog)
write('frames.json', frames)
write(
  'worktrees.txt',
  worktrees + '\n--- dirs under HOME with "worktree" in the path ---\n' + found
)
if (execOut) write('exec.txt', execOut)
if (relay) write('app-server-stderr.txt', relay.stderr())
for (const f of ['screen.txt']) {
  const p = path.join(outDir, f)
  if (fs.existsSync(p)) fs.writeFileSync(p, scrub(fs.readFileSync(p, 'utf8')))
}
fs.rmSync(path.join(outDir, 'screen'), { force: true })
console.log('done', kase)
process.exit(0)
