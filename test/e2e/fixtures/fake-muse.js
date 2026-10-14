#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')

const ESC = '\x1b'
const STATUS_ASK = `${ESC}]7501;?${ESC}\\`
const STATUS_ON = `${ESC}]7501;?:states=`
const argv = process.argv.slice(2)
const home = process.env.HOME
const museHome = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'muse')
const sessionsDir = path.join(museHome, 'sessions', 'fake')
const registryDir = path.join(museHome, 'runtime', 'muse', 'sessions')
const trustFile = path.join(home, '.config', 'muse', 'trust.json')
const file = (name) => path.join(home, name)
const read = (name, fallback = '') => {
  try {
    return fs.readFileSync(file(name), 'utf8').trim()
  } catch {
    return fallback
  }
}
const append = (name, value) => fs.appendFileSync(file(name), JSON.stringify(value) + '\n')
const now = () => new Date().toISOString()

const load = (id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionsDir, id + '.json'), 'utf8'))
  } catch {
    return undefined
  }
}
const save = (s) => {
  fs.mkdirSync(sessionsDir, { recursive: true })
  const target = path.join(sessionsDir, s.id + '.json')
  fs.writeFileSync(target + '.tmp', JSON.stringify(s))
  fs.renameSync(target + '.tmp', target)
}
const all = () =>
  fs.existsSync(sessionsDir)
    ? fs
        .readdirSync(sessionsDir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => load(n.slice(0, -5)))
        .filter(Boolean)
    : []

if (argv[0] === '--version') {
  process.stdout.write('Muse Code 1.4.7 (1.4.7-R6101.1)\n')
  process.exit(0)
}

if (argv[0] === 'serve') serve()
else tui()

function serve() {
  const echo = argv.includes('--provider') && argv[argv.indexOf('--provider') + 1] === 'echo'
  const reply = (id, result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  const refuse = (id, message) =>
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } }) + '\n'
    )
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id === undefined) return
    if (msg.method === 'initialize') return reply(msg.id, { museHome })
    if (msg.method === 'session/list') {
      const sessions = all()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((s) => ({
          sessionId: s.id,
          path: path.join(sessionsDir, s.id + '.json'),
          status: 'notLoaded',
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          workspaceRoot: s.cwd,
          kind: 'root',
          name: 'fake-name',
          title: s.title,
          firstUserPrompt: s.title
        }))
      return reply(msg.id, { sessions, nextCursor: null })
    }
    if (msg.method === 'session/read') {
      if (!echo && !fs.existsSync(file('fake-muse-logged-in')))
        return refuse(msg.id, 'retained session refused (class c)')
      const s = load(msg.params.sessionId)
      if (!s) return refuse(msg.id, 'no such session')
      return reply(msg.id, {
        session: { sessionId: s.id },
        history: { mode: 'inline', items: s.items }
      })
    }
    refuse(msg.id, `unsupported ${msg.method}`)
  })
}

function tui() {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (['--model', '--reasoning-effort', '--approval-mode'].includes(a)) flags[a] = argv[++i]
    else if (a === '--trust-workspace') flags.trust = true
    else rest.push(a)
  }
  let resumeId = rest[0] === 'resume' ? rest[1] : undefined
  const firstPrompt = rest[0] === 'resume' ? undefined : rest[0]
  let statusOn = false
  let session
  let blocked = false
  let current
  const status = (s) => {
    current = s === 'state=clear' ? undefined : s
    if (statusOn) process.stdout.write(`${ESC}]7501;${s}${ESC}\\`)
  }
  const register = () => {
    fs.mkdirSync(registryDir, { recursive: true })
    fs.writeFileSync(
      path.join(registryDir, session.id + '.json'),
      JSON.stringify({
        schema_version: 1,
        session_id: session.id,
        endpoint_hint: 'ms-fake.sock',
        process_generation_hint: `pid=${process.pid}`
      })
    )
  }
  const unregister = () => fs.rmSync(path.join(registryDir, session.id + '.json'), { force: true })
  const open = (id) => {
    session = (id && load(id)) || {
      id: crypto.randomUUID(),
      cwd: fs.realpathSync(process.cwd()),
      title: null,
      createdAt: now(),
      updatedAt: now(),
      items: []
    }
    save(session)
    register()
    append('fake-muse-calls.jsonl', {
      pid: process.pid,
      argv,
      cwd: process.cwd(),
      sessionId: session.id,
      pathHead: (process.env.PATH || '').split(':')[0]
    })
    process.stdout.write(`Muse fixture ready ${session.id}\r\n`)
  }
  const turn = (text) => {
    status('state=working:app=muse')
    session.items.push({
      itemId: crypto.randomUUID(),
      kind: 'userMessage',
      text,
      recordedAt: now()
    })
    session.title ||= text
    session.updatedAt = now()
    save(session)
    setTimeout(
      () => {
        session.items.push({
          itemId: crypto.randomUUID(),
          kind: 'agentMessage',
          text: `echo: ${text}`,
          recordedAt: now()
        })
        save(session)
        process.stdout.write(`echo: ${text}\r\n`)
        status('state=done:app=muse')
      },
      Number(read('fake-muse-delay', '300'))
    )
  }
  const trusted = () => {
    if (flags.trust) return true
    try {
      const t = JSON.parse(fs.readFileSync(trustFile, 'utf8'))
      return t.projects?.[fs.realpathSync(process.cwd())]?.decision === 'trusted'
    } catch {
      return false
    }
  }
  const start = () => {
    open(resumeId)
    status('state=idle:app=muse')
    if (firstPrompt) turn(firstPrompt)
  }
  let asking = !trusted()
  const line = (text) => {
    if (asking) {
      asking = false
      const t = fs.existsSync(trustFile) ? JSON.parse(fs.readFileSync(trustFile, 'utf8')) : {}
      t.schema_version = 1
      t.projects = { ...t.projects, [fs.realpathSync(process.cwd())]: { decision: 'trusted' } }
      fs.mkdirSync(path.dirname(trustFile), { recursive: true })
      fs.writeFileSync(trustFile, JSON.stringify(t))
      return start()
    }
    if (blocked) {
      blocked = false
      return status('state=done:app=muse')
    }
    if (text === '/exit') {
      status('state=clear')
      process.exit(0)
    }
    if (text === '/clear' || text === '/new' || text.startsWith('/resume ')) {
      unregister()
      status('state=clear')
      resumeId = text.startsWith('/resume ') ? text.slice('/resume '.length).trim() : undefined
      open(resumeId)
      status('state=idle:app=muse')
      return
    }
    if (text === '/block') {
      blocked = true
      return status('state=blocked:app=muse:kind=permission')
    }
    if (text.startsWith('!')) {
      status('state=working:app=muse')
      return setTimeout(() => status('state=error:app=muse'), 100)
    }
    if (text) turn(text)
  }
  process.stdout.write(STATUS_ASK)
  if (asking) process.stdout.write('Do you trust this workspace? 1 Trust and continue 2 Quit\r\n')
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  let typed = ''
  process.stdin.on('data', (chunk) => {
    let text = chunk.toString('utf8')
    if (text.includes(STATUS_ON)) {
      statusOn = true
      text = text.replace(/\x1b\]7501;\?:[^\x07\x1b]*(\x07|\x1b\\)/g, '')
      if (current) status(current)
    }
    for (const ch of text.replace(/\x1b\[20[01]~/g, '')) {
      if (ch === '\r' || ch === '\n') {
        const done = typed
        typed = ''
        line(done.trim())
      } else if (ch === '\x7f') typed = typed.slice(0, -1)
      else if (ch >= ' ') typed += ch
    }
  })
  process.on('SIGHUP', () => process.exit(0))
  if (!asking) start()
}
