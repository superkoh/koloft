import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cxprobe-'))
const home = path.join(base, 'codex-home')
const work = path.join(base, 'work')
fs.mkdirSync(home)
fs.mkdirSync(work)
fs.copyFileSync(path.join(os.homedir(), '.codex/auth.json'), path.join(home, 'auth.json'))
fs.writeFileSync(path.join(work, 'README.md'), '# demo\n')

const child = spawn(path.join(os.homedir(), '.local/bin/codex'), ['app-server'], {
  env: { ...process.env, CODEX_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe']
})
let buf = ''
let nextId = 1
const pending = new Map()
const methods = new Map()
const items = []
let planDeltaChars = 0
let done
const finished = new Promise((r) => (done = r))
child.stderr.on('data', () => {})
child.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const f = JSON.parse(line)
    if (f.id !== undefined && pending.has(f.id) && f.method === undefined) {
      pending.get(f.id)(f)
      pending.delete(f.id)
      continue
    }
    if (f.method) {
      methods.set(f.method, (methods.get(f.method) ?? 0) + 1)
      if (f.method === 'item/plan/delta') planDeltaChars += f.params.delta.length
      if (f.method === 'item/completed') {
        const it = f.params.item
        items.push({ type: it.type, keys: Object.keys(it), textLen: typeof it.text === 'string' ? it.text.length : undefined })
      }
      if (f.method === 'turn/completed') done()
      if (f.id !== undefined) child.stdin.write(JSON.stringify({ id: f.id, result: { decision: 'decline' } }) + '\n')
    }
  }
})
const send = (method, params) =>
  new Promise((r) => {
    const id = nextId++
    pending.set(id, r)
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })

const init = await send('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '1' }, capabilities: { experimentalApi: true } })
if (init.error) throw new Error(JSON.stringify(init.error))
child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
const modes = await send('collaborationMode/list', {})
console.log('collaborationMode/list:', JSON.stringify(modes.result ?? modes.error))
const models = await send('model/list', {})
const model = (models.result?.data ?? []).find((m) => m.isDefault)?.model ?? models.result?.data?.[0]?.model
const th = await send('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'read-only' })
if (th.error) throw new Error(JSON.stringify(th.error))
const turn = await send('turn/start', {
  threadId: th.result.thread.id,
  input: [{ type: 'text', text: 'Plan how to add a CONTRIBUTING.md to this folder. Keep the plan to 3 short steps. Do not ask me questions.' }],
  collaborationMode: { mode: 'plan', settings: { model, developer_instructions: null } }
})
if (turn.error) throw new Error(JSON.stringify(turn.error))
const timer = setTimeout(() => done(), 240000)
await finished
clearTimeout(timer)
console.log('notification methods:', JSON.stringify([...methods.entries()]))
console.log('completed items:', JSON.stringify(items))
console.log('plan delta chars:', planDeltaChars)
console.log('files in work:', fs.readdirSync(work))
child.kill()
fs.rmSync(base, { recursive: true, force: true })
