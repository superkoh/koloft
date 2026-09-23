#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const WebSocket = require('ws')

const argv = process.argv.slice(2)
const home = process.env.HOME
const codexHome = process.env.CODEX_HOME || path.join(home, '.codex')
const sessions = path.join(codexHome, 'sessions')
fs.mkdirSync(sessions, { recursive: true })
const file = (name) => path.join(home, name)
const flag = (name) => fs.existsSync(file(name))
const read = (name, fallback = '') => {
  try {
    return fs.readFileSync(file(name), 'utf8').trim()
  } catch {
    return fallback
  }
}
const append = (name, value) => fs.appendFileSync(file(name), JSON.stringify(value) + '\n')
const load = (id) => {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return undefined
  try {
    return JSON.parse(fs.readFileSync(path.join(sessions, id + '.json'), 'utf8'))
  } catch {
    return undefined
  }
}
const save = (thread) => {
  const target = path.join(sessions, thread.id + '.json')
  fs.writeFileSync(target + '.tmp', JSON.stringify(thread))
  fs.renameSync(target + '.tmp', target)
}
const persistTurn = (thread, text) => {
  thread.path = path.join(sessions, thread.id + '.jsonl')
  thread.preview ||= text
  fs.appendFileSync(
    thread.path,
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } }) + '\n'
  )
  save(thread)
}
const newThread = (cwd, predecessor) => {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: crypto.randomUUID(),
    cwd,
    path: null,
    name: null,
    preview: predecessor?.preview || '',
    createdAt: now,
    updatedAt: now,
    cliVersion: '0.153.4',
    model: 'gpt-5.5',
    modelProvider: 'openai',
    source: 'cli',
    threadSource: 'user',
    ephemeral: false,
    canAcceptDirectInput: true,
    status: { type: 'idle' },
    turns: []
  }
}

if (argv.includes('--version')) {
  const versionProbeBlockingDelayMs = Number(read('fake-codex-version-delay')) || 0
  if (versionProbeBlockingDelayMs > 0)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, versionProbeBlockingDelayMs)
  console.log('codex-cli 0.153.4')
  process.exit(0)
}

if (argv[0] === 'app-server') {
  append('fake-codex-server-calls.jsonl', { argv, cwd: process.cwd() })
  let initialized = false
  let active
  let activeTurn
  let pendingApproval
  const emit = (frame) => {
    append('fake-codex-wire.jsonl', { direction: 'server', frame })
    process.stdout.write(JSON.stringify(frame) + '\n')
  }
  const result = (id, value) => emit({ id, result: value })
  const error = (id, message) => emit({ id, error: { code: -32000, message } })
  const event = (method, params) => emit({ method, params })
  const status = (thread, value) => {
    thread.status = value
    save(thread)
    event('thread/status/changed', { threadId: thread.id, status: value })
  }
  const complete = (thread, turn) => {
    if (turn.status === 'interrupted') return
    turn.status = 'completed'
    thread.updatedAt = Math.floor(Date.now() / 1000)
    const desired = read('fake-codex-next-title')
    if (desired) {
      fs.unlinkSync(file('fake-codex-next-title'))
      thread.name = desired
    } else thread.name ||= thread.preview.slice(0, 60) || 'Codex fixture session'
    thread.turns.push(turn)
    status(thread, { type: 'idle' })
    event('thread/name/updated', { threadId: thread.id, threadName: thread.name })
    event('thread/tokenUsage/updated', {
      threadId: thread.id,
      turnId: turn.id,
      tokenUsage: {
        total: { inputTokens: 120, outputTokens: 25, cachedInputTokens: 10, totalTokens: 145 },
        last: { inputTokens: 120, outputTokens: 25, totalTokens: 145 },
        modelContextWindow: 272000
      }
    })
    event('turn/completed', { threadId: thread.id, turn })
  }
  const lines = readline.createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      process.exit(2)
    }
    append('fake-codex-wire.jsonl', { direction: 'client', frame })
    const { id, method, params: p = {} } = frame
    if (method === 'initialize') {
      result(id, { userAgent: 'fake-codex/0.153.4', platformFamily: 'unix' })
      return
    }
    if (method === 'initialized') {
      initialized = true
      return
    }
    if (!initialized) {
      error(id, 'Not initialized')
      return
    }
    if (!method && pendingApproval && id === pendingApproval.id) {
      const { thread, turn } = pendingApproval
      pendingApproval = undefined
      status(thread, { type: 'active', activeFlags: [] })
      complete(thread, turn)
      return
    }
    if (method === 'thread/list') {
      if (flag('fake-codex-history-error')) {
        error(id, 'History is unavailable')
        return
      }
      const data = p.archived
        ? []
        : fs
            .readdirSync(sessions)
            .filter((n) => n.endsWith('.json'))
            .map((n) => load(n.slice(0, -5)))
            .filter(Boolean)
      result(id, { data, nextCursor: null })
      return
    }
    if (method === 'thread/read') {
      const thread = load(p.threadId)
      if (!thread) error(id, 'Thread not found')
      else result(id, { thread })
      return
    }
    if (['thread/start', 'thread/resume', 'thread/fork'].includes(method)) {
      const previous = p.threadId ? load(p.threadId) : undefined
      if (method !== 'thread/start' && !previous) {
        error(id, 'Thread not found')
        return
      }
      active = method === 'thread/resume' ? previous : newThread(p.cwd || process.cwd(), previous)
      if (p.cwd) active.cwd = p.cwd
      if (method === 'thread/fork' && previous.path)
        persistTurn(active, previous.preview || 'Forked session')
      save(active)
      const opened = active
      setTimeout(
        () => {
          result(id, {
            thread: opened,
            model: opened.model,
            modelProvider: 'openai',
            cwd: opened.cwd,
            approvalPolicy: 'on-request',
            sandbox: { type: 'workspaceWrite' },
            reasoningEffort: 'medium'
          })
          event('thread/started', { thread: opened })
        },
        Number(read('fake-codex-delay', '0')) || 0
      )
      return
    }
    if (method === 'thread/unsubscribe') {
      result(id, { status: 'unsubscribed' })
      return
    }
    if (method === 'turn/start') {
      const thread = active?.id === p.threadId ? active : load(p.threadId)
      if (!thread) {
        error(id, 'Thread not found')
        return
      }
      const text = (p.input || []).map((item) => item.text || '').join('\n')
      persistTurn(thread, text)
      const turn = { id: crypto.randomUUID(), status: 'inProgress', items: [], error: null }
      activeTurn = turn
      result(id, { turn })
      status(thread, { type: 'active', activeFlags: [] })
      event('turn/started', { threadId: thread.id, turn })
      if (text.includes('approve')) {
        pendingApproval = { id: 'approval-' + turn.id, thread, turn }
        status(thread, { type: 'active', activeFlags: ['waitingOnApproval'] })
        emit({
          id: pendingApproval.id,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            itemId: 'command-1',
            command: 'echo approved',
            cwd: thread.cwd
          }
        })
      } else if (!text.includes('hold')) setTimeout(() => complete(thread, turn), 120)
      return
    }
    if (method === 'turn/interrupt') {
      result(id, {})
      pendingApproval = undefined
      if (active && activeTurn) {
        activeTurn.status = 'interrupted'
        status(active, { type: 'idle' })
        event('turn/completed', { threadId: active.id, turn: activeTurn })
      }
      return
    }
    if (method === 'config/read') {
      result(id, { config: { model: 'gpt-5.5' }, origins: {}, layers: [] })
      return
    }
    if (method === 'account/read') {
      result(id, {
        account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' },
        requiresOpenaiAuth: false
      })
      return
    }
    if (method === 'account/rateLimits/read') {
      result(id, { rateLimits: null, rateLimitsByLimitId: {} })
      return
    }
    if (method === 'model/list') {
      result(id, { data: [], nextCursor: null })
      return
    }
    if (method === 'thread/loaded/list') {
      result(id, { data: active ? [active.id] : [] })
      return
    }
    if (id !== undefined) result(id, {})
  })
  process.stdin.on('end', () => process.exit(0))
} else {
  void startTui()
}

async function startTui() {
  if (flag('fake-codex-exit')) {
    console.error('Codex fixture startup failure')
    process.exit(Number(read('fake-codex-exit')) || 1)
  }
  const resume = argv.indexOf('resume')
  if (resume >= 0 && flag('fake-codex-confirm-resume')) {
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdout.write('Resume ' + argv[resume + 1] + ': press Enter to continue\r\n')
    await new Promise((resolve) => {
      const confirm = (bytes) => {
        if (!bytes.toString().includes('\r')) return
        process.stdin.off('data', confirm)
        resolve()
      }
      process.stdin.on('data', confirm)
    })
    process.stdin.pause()
  }
  const value = (key) => {
    const i = argv.indexOf(key)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const url = value('--remote')
  const cwd = value('-C') || process.cwd()
  if (!url) {
    console.error('fake-codex needs --remote')
    process.exit(2)
  }
  const ws = new WebSocket(url.startsWith('unix://') ? 'ws+unix://' + url.slice(7) + ':/' : url)
  let id = 0
  let thread
  let turnId
  let working = false
  let approval
  let typed = ''
  const pending = new Map()
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++id
      pending.set(requestId, { resolve, reject })
      ws.send(JSON.stringify({ id: requestId, method, params }))
    })
  const prompt = (text) =>
    send('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] })
  const open = async (method, params) => {
    const response = await send(method, params)
    thread = response.thread
    append('fake-codex-calls.jsonl', {
      pid: process.pid,
      argv,
      cwd,
      effectiveCwd: thread.cwd,
      sessionId: thread.id,
      method,
      ts: Date.now(),
      backend: 'codex',
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
      cdpEndpoint: process.env.KOLOFT_BROWSER_CDP || null
    })
    process.stdout.write('\r\nCodex fixture ready ' + thread.id + '\r\n> ')
    if (method === 'thread/start' && !flag('fake-codex-lazy'))
      await prompt(read('fake-codex-next-title', 'Codex fixture session'))
  }
  const exit = async () => {
    if (thread) await send('thread/unsubscribe', { threadId: thread.id }).catch(() => {})
    ws.close()
  }
  const input = async (text) => {
    if (!text.trim()) return
    if (approval) {
      ws.send(
        JSON.stringify({
          id: approval,
          result: { decision: text.toLowerCase().startsWith('y') ? 'accept' : 'decline' }
        })
      )
      approval = undefined
    } else if (text === '/exit' || text === '/quit') await exit()
    else if (text === '/new') await open('thread/start', { cwd })
    else if (text === '/fork') await open('thread/fork', { threadId: thread.id, cwd })
    else if (text.startsWith('/resume '))
      await open('thread/resume', { threadId: text.slice(8).trim(), cwd })
    else await prompt(text)
  }
  ws.on('message', (bytes) => {
    const frame = JSON.parse(bytes.toString())
    if (frame.method === 'item/commandExecution/requestApproval') {
      approval = frame.id
      process.stdout.write('\r\nApprove command? [y/n] ')
    } else if (frame.method === 'turn/started') {
      working = true
      turnId = frame.params.turn.id
    } else if (frame.method === 'turn/completed') {
      working = false
      process.stdout.write('\r\nCodex done\r\n> ')
    } else if (!frame.method && pending.has(frame.id)) {
      const waiting = pending.get(frame.id)
      pending.delete(frame.id)
      if (frame.error) waiting.reject(new Error(frame.error.message))
      else waiting.resolve(frame.result)
    }
  })
  ws.on('error', (error) => {
    console.error(error.message)
    process.exit(1)
  })
  ws.on('close', () => process.exit(0))
  ws.on('open', async () => {
    try {
      await send('initialize', {
        clientInfo: { name: 'codex_cli_rs', version: '0.153.4' },
        capabilities: { experimentalApi: true }
      })
      ws.send(JSON.stringify({ method: 'initialized' }))
      const resume = argv.indexOf('resume')
      await open(
        resume >= 0 ? 'thread/resume' : 'thread/start',
        resume >= 0 ? { threadId: argv[resume + 1], cwd } : { cwd }
      )
      process.stdin.setRawMode?.(true)
      process.stdin.resume()
      process.stdin.on('data', (bytes) => {
        for (const ch of bytes.toString('utf8')) {
          if (ch === '\u0003') {
            if (working) void send('turn/interrupt', { threadId: thread.id, turnId })
            else void exit()
            return
          }
          if (ch === '\r' || ch === '\n') {
            const line = typed
            typed = ''
            process.stdout.write('\r\n')
            void input(line).catch((error) => process.stdout.write(error.message + '\r\n'))
          } else if (ch === '\u007f') typed = typed.slice(0, -1)
          else {
            typed += ch
            process.stdout.write(ch)
          }
        }
      })
    } catch (error) {
      console.error(error.message)
      process.exit(1)
    }
  })
}
