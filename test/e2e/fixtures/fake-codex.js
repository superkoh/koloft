#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const { execFile, spawnSync } = require('child_process')

const VERSION_AT_KOLOFTS_MINIMUM = '0.161.0'
const FLAGS_FOLLOWED_BY_A_VALUE = ['--remote', '-C', '-c', '-m', '-a', '-s']

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
const savedThreads = () =>
  fs
    .readdirSync(sessions)
    .filter((n) => n.endsWith('.json'))
    .map((n) => load(n.slice(0, -5)))
    .filter(Boolean)
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
    cliVersion: VERSION_AT_KOLOFTS_MINIMUM,
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
  console.log(`codex-cli ${VERSION_AT_KOLOFTS_MINIMUM}`)
  process.exit(0)
}

if (argv[0] === 'login' && flag('fake-codex-login-waits')) {
  fs.writeSync(1, 'Open this page to sign in: https://auth.openai.com/oauth/authorize?fake=1\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

if (argv[0] === 'login') {
  const usedPercent = Number(read('fake-codex-login-used')) || 30
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ usedPercent }))
  console.log('Successfully logged in')
  process.exit(0)
}

// CODEX§16
const SHELL = fs.existsSync('/bin/zsh') ? '/bin/zsh' : process.env.SHELL || '/bin/sh'
const SHELL_FLAG = argv.includes('allow_login_shell=false') ? '-c' : '-lc'

let loginFromTheClient = null

function signIn() {
  if (loginFromTheClient) return loginFromTheClient
  try {
    return JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'))
  } catch {
    return codexHome === path.join(home, '.codex') ? {} : null
  }
}

const argValue = (key) => {
  const i = argv.indexOf(key)
  return i >= 0 ? argv[i + 1] : undefined
}

if (argv[0] === 'app-server' && argv[1] === 'proxy') {
  const net = require('net')
  const requested = argValue('--sock')
  let target = requested
  try {
    target = fs.realpathSync(requested)
  } catch {}
  const socket = net.connect(target)
  socket.on('error', (error) => {
    console.error(`failed to connect to ${requested}: ${error.message}`)
    process.exit(1)
  })
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
  socket.on('close', () => process.exit(0))
} else if (argv[0] === 'app-server') {
  append('fake-codex-server-calls.jsonl', {
    pid: process.pid,
    argv,
    cwd: process.cwd(),
    codexHome,
    tabId: process.env.KOLOFT_TAB_ID || null,
    portOffset: process.env.KOLOFT_PORT_OFFSET || null,
    playwrightMcpEndpoint: process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT || null,
    codexGate: process.env.KOLOFT_CODEX_GATE || null,
    gitConfigIncludes: Object.keys(process.env)
      .filter((k) => /^GIT_CONFIG_VALUE_\d+$/.test(k))
      .map((k) => process.env[k])
  })
  // CODEX§27
  const sessionHooks = argv.flatMap((value) => {
    const m = /^hooks\.(\w+)=.*command=("(?:[^"\\]|\\.)*")/.exec(value)
    return m ? [{ event: m[1], command: JSON.parse(m[2]) }] : []
  })
  const snakeCase = (event) => event.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase())
  const gateHooks = () => {
    let config = ''
    try {
      config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')
    } catch {}
    const lines = config.split('\n')
    const hooks = []
    for (const { event, command } of sessionHooks) {
      const key = `/<session-flags>/config.toml:${snakeCase(event)}:0:0`
      const table = `[hooks.state."${key}"]`
      const currentHash = 'sha256:' + crypto.createHash('sha256').update(command).digest('hex')
      if (lines.filter((line) => line.trim() === table).length > 1)
        return { hooks: [], errors: [{ path: process.cwd(), message: 'duplicate key' }] }
      const at = lines.findIndex((line) => line.trim() === table)
      const saved =
        at < 0 ? undefined : /^trusted_hash = "(.*)"$/.exec(lines[at + 1]?.trim() ?? '')?.[1]
      const trustStatus = flag('fake-codex-hook-untrusted')
        ? 'untrusted'
        : saved === currentHash
          ? 'trusted'
          : saved
            ? 'modified'
            : 'untrusted'
      const eventName = event.charAt(0).toLowerCase() + event.slice(1)
      hooks.push({ key, eventName, command, source: 'sessionFlags', currentHash, trustStatus })
    }
    return { hooks, errors: [] }
  }
  const runHook = (event, payload) => {
    const eventName = event.charAt(0).toLowerCase() + event.slice(1)
    const hook = gateHooks().hooks.find((h) => h.eventName === eventName)
    if (hook?.trustStatus !== 'trusted') return
    const ran = spawnSync('/bin/sh', ['-c', hook.command], {
      input: JSON.stringify({ ...payload, hook_event_name: event }),
      encoding: 'utf8'
    })
    append('fake-codex-hook-output.jsonl', { event, stdout: ran.stdout })
    return ran.stdout
  }
  const serve = (write) => {
    let initialized = false
    let active
    let activeTurn
    let pendingApproval
    const emit = (frame) => {
      append('fake-codex-wire.jsonl', { direction: 'server', frame })
      write(JSON.stringify(frame))
    }
    const result = (id, value) => emit({ id, result: value })
    const error = (id, message) => emit({ id, error: { code: -32000, message } })
    const event = (method, params) => emit({ method, params })
    const status = (thread, value) => {
      thread.status = value
      save(thread)
      event('thread/status/changed', { threadId: thread.id, status: value })
    }
    // CODEX§27
    const keepGoingIfStopped = (thread, turn) => {
      const stop = (active) =>
        runHook('Stop', {
          session_id: thread.id,
          cwd: thread.cwd,
          turn_id: turn.id,
          stop_hook_active: active
        })
      let reason
      try {
        const parsed = JSON.parse(stop(false) || '')
        if (parsed.decision === 'block') reason = parsed.reason
      } catch {
        return
      }
      if (typeof reason !== 'string') return
      const prompt = { type: 'hookPrompt', id: crypto.randomUUID(), text: reason }
      const answer = { type: 'agentMessage', id: crypto.randomUUID(), text: `Stop said: ${reason}` }
      for (const item of [prompt, answer]) {
        turn.items.push(item)
        event('item/completed', { threadId: thread.id, turnId: turn.id, item })
      }
      stop(true)
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
      const asked = turn.items.find((item) => item.type === 'userMessage')?.content[0].text
      keepGoingIfStopped(thread, turn)
      const reply = {
        type: 'agentMessage',
        id: crypto.randomUUID(),
        text: `Codex fixture answered: ${asked}`,
        phase: 'final_answer'
      }
      turn.items.push(reply)
      event('item/completed', { threadId: thread.id, turnId: turn.id, item: reply })
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
      queued.shift()?.()
    }
    const queued = []
    const startTurn = (thread, text, clientId, started) => {
      persistTurn(thread, text)
      const turn = { id: crypto.randomUUID(), status: 'inProgress', items: [], error: null }
      activeTurn = turn
      started?.(turn)
      status(thread, { type: 'active', activeFlags: [] })
      event('turn/started', { threadId: thread.id, turn })
      // CODEX§19
      const asked = {
        type: 'userMessage',
        id: crypto.randomUUID(),
        clientId,
        content: [{ type: 'text', text, text_elements: [] }]
      }
      turn.items.push(asked)
      event('item/completed', { threadId: thread.id, turnId: turn.id, item: asked })
      // CODEX§34
      const diesOn = read('fake-codex-server-dies-on')
      if (diesOn && text.includes(diesOn)) {
        fs.unlinkSync(file('fake-codex-server-dies-on'))
        append('fake-codex-server-deaths.jsonl', { pid: process.pid, text })
        process.exit(1)
      }
      runHook('UserPromptSubmit', { session_id: thread.id, cwd: thread.cwd, prompt: text })
      if (text.startsWith('open ')) {
        const shell = spawnSync(SHELL, [SHELL_FLAG, text], { cwd: thread.cwd, encoding: 'utf8' })
        event('item/completed', {
          threadId: thread.id,
          turnId: turn.id,
          item: {
            type: 'commandExecution',
            id: 'open-' + turn.id,
            status: shell.status === 0 ? 'completed' : 'failed',
            exitCode: shell.status,
            aggregatedOutput: (shell.stdout || '') + (shell.stderr || ''),
            command: `${SHELL} ${SHELL_FLAG} '${text}'`,
            cwd: thread.cwd,
            commandActions: [{ type: 'unknown', command: text }]
          }
        })
      }
      if (text.startsWith('/write ')) {
        const target = path.join(thread.cwd, text.slice('/write '.length).trim())
        const diff = 'written by Codex\n'
        fs.writeFileSync(target, diff)
        // CODEX§12
        event('item/completed', {
          threadId: thread.id,
          turnId: turn.id,
          item: {
            type: 'fileChange',
            id: 'write-' + turn.id,
            status: 'completed',
            changes: [{ path: target, kind: { type: 'add' }, diff }]
          }
        })
      }
      const ran = /^\/(koloft|sh) (.+)$/s.exec(text)
      if (ran) {
        const [, tool, rest] = ran
        const command = tool === 'koloft' ? `koloft ${rest.trim()}` : rest.trim()
        execFile(SHELL, [SHELL_FLAG, command], { cwd: thread.cwd }, (e, out, err) => {
          const exitCode = e ? (typeof e.code === 'number' ? e.code : 1) : 0
          event('item/completed', {
            threadId: thread.id,
            turnId: turn.id,
            item: {
              type: 'commandExecution',
              id: `${tool}-${turn.id}`,
              status: exitCode === 0 ? 'completed' : 'failed',
              exitCode,
              aggregatedOutput: `${out}${err}`,
              command: `${SHELL} ${SHELL_FLAG} '${command}'`,
              cwd: thread.cwd,
              commandActions: [{ type: 'unknown', command }]
            }
          })
          runHook('PostToolUse', { session_id: thread.id, cwd: thread.cwd, tool_name: 'Bash' })
          complete(thread, turn)
        })
        return
      }
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
      } else if (text.includes('ask me')) {
        pendingApproval = { id: 'question-' + turn.id, thread, turn }
        status(thread, { type: 'active', activeFlags: ['waitingOnUserInput'] })
        // CODEX§20
        emit({
          id: pendingApproval.id,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            itemId: 'call-1',
            questions: [
              {
                id: 'colour',
                header: 'Colour',
                question: 'Which colour do you prefer?',
                isOther: true,
                isSecret: false,
                options: [
                  { label: 'Red', description: 'Choose red.' },
                  { label: 'Green', description: 'Choose green.' }
                ]
              }
            ],
            isBlocking: false,
            autoResolutionMs: null
          }
        })
      } else if (text.includes('spawn child')) {
        // CODEX§4
        const childId = crypto.randomUUID()
        event('item/completed', {
          threadId: thread.id,
          turnId: turn.id,
          item: {
            type: 'collabAgentToolCall',
            id: 'spawn-' + turn.id,
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: thread.id,
            receiverThreadIds: [childId],
            agentsStates: { [childId]: { status: 'pendingInit' } }
          }
        })
        setTimeout(() => complete(thread, turn), 120)
        setTimeout(
          () => event('thread/status/changed', { threadId: childId, status: { type: 'idle' } }),
          Number(read('fake-codex-child-ms', '4000'))
        )
      } else if (text === '/busy')
        setTimeout(() => complete(thread, turn), Number(read('fake-codex-busy-ms', '15000')))
      else if (!text.includes('hold')) setTimeout(() => complete(thread, turn), 120)
    }
    return (line) => {
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        process.exit(2)
      }
      append('fake-codex-wire.jsonl', { direction: 'client', frame })
      const { id, method, params: p = {} } = frame
      // CODEX§34
      if (method === 'initialize' && initialized) {
        emit({ error: { code: -32600, message: 'Already initialized' }, id })
        return
      }
      if (method === 'initialize') {
        result(id, {
          userAgent: `fake-codex/${VERSION_AT_KOLOFTS_MINIMUM}`,
          platformFamily: 'unix'
        })
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
        result(id, { data: p.archived ? [] : savedThreads(), nextCursor: null })
        return
      }
      const said = (thread) =>
        thread.turns
          .flatMap((turn) => turn.items)
          .map((item) =>
            item.type === 'agentMessage'
              ? item.text
              : (item.content ?? []).map((c) => c.text).join(' ')
          )
          .filter(Boolean)
      // CODEX§24
      if (method === 'thread/search') {
        const term = String(p.searchTerm).toLowerCase()
        const environment = (thread) =>
          `<environment_context> <cwd>${thread.cwd}</cwd> <shell>zsh</shell> </environment_context>`
        const data = (p.archived ? [] : savedThreads()).flatMap((thread) => {
          const snippet = [environment(thread), ...said(thread)].find((text) =>
            text.toLowerCase().includes(term)
          )
          return snippet ? [{ snippet, thread }] : []
        })
        result(id, { data, nextCursor: null, backwardsCursor: null })
        return
      }
      if (method === 'thread/searchOccurrences') {
        const term = String(p.searchTerm).toLowerCase()
        const thread = load(p.threadId)
        const snippet = thread && said(thread).find((text) => text.toLowerCase().includes(term))
        result(id, { data: snippet ? [{ snippet }] : [], nextCursor: null })
        return
      }
      if (method === 'thread/turns/list') {
        const thread = load(p.threadId)
        if (!thread) error(id, 'Thread not found')
        else result(id, { data: thread.turns, nextCursor: null })
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
      // CODEX§17
      if (method === 'thread/name/set') {
        const thread = active?.id === p.threadId ? active : load(p.threadId)
        if (!thread) {
          error(id, 'Thread not found')
          return
        }
        thread.name = p.name
        save(thread)
        result(id, {})
        event('thread/name/updated', { threadId: thread.id, threadName: thread.name })
        return
      }
      if (method === 'turn/start' || method === 'thread/queue/add') {
        const thread = active?.id === p.threadId ? active : load(p.threadId)
        if (!thread) {
          error(id, 'Thread not found')
          return
        }
        const text = (p.input || []).map((item) => item.text || '').join('\n')
        // CODEX§17
        if (method === 'thread/queue/add') {
          result(id, { queuedSubmission: { id: crypto.randomUUID() } })
          const begin = () => startTurn(thread, text, p.clientUserMessageId ?? null)
          if (activeTurn?.status === 'inProgress') queued.push(begin)
          else begin()
          return
        }
        startTurn(thread, text, null, (turn) => result(id, { turn }))
        return
      }
      // CODEX§21
      if (method === 'thread/compact/start') {
        const thread = active?.id === p.threadId ? active : load(p.threadId)
        if (!thread) {
          error(id, 'Thread not found')
          return
        }
        result(id, {})
        const turn = { id: crypto.randomUUID(), status: 'inProgress', items: [], error: null }
        const item = { type: 'contextCompaction', id: crypto.randomUUID() }
        activeTurn = turn
        status(thread, { type: 'active', activeFlags: [] })
        event('turn/started', { threadId: thread.id, turn })
        event('item/started', { threadId: thread.id, turnId: turn.id, item })
        setTimeout(() => {
          event('item/completed', { threadId: thread.id, turnId: turn.id, item })
          turn.status = 'completed'
          status(thread, { type: 'idle' })
          event('turn/completed', { threadId: thread.id, turn })
          queued.shift()?.()
        }, 120)
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
        const mcpServers = read('fake-codex-mcp-servers.json')
        result(id, {
          config: { model: 'gpt-5.5', ...(mcpServers && { mcp_servers: JSON.parse(mcpServers) }) },
          origins: {},
          layers: []
        })
        return
      }
      if (method === 'account/read' && flag('fake-codex-account-read-fails')) {
        append('fake-codex-account-read-failures.jsonl', { codexHome, signedIn: !!signIn() })
        error(id, 'stream disconnected before completion')
        return
      }
      if (method === 'account/read') {
        result(id, {
          account: signIn()
            ? { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' }
            : null,
          requiresOpenaiAuth: false
        })
        return
      }
      if (method === 'account/rateLimits/read') {
        const auth = signIn()
        const now = Math.floor(Date.now() / 1000)
        result(id, {
          rateLimits:
            auth && auth.usedPercent !== undefined
              ? {
                  limitId: 'codex',
                  primary: {
                    usedPercent: auth.usedPercent,
                    windowDurationMins: 10080,
                    resetsAt: now + 3600
                  },
                  secondary: null,
                  credits:
                    auth.balance !== undefined
                      ? { hasCredits: true, unlimited: false, balance: auth.balance }
                      : null,
                  rateLimitReachedType: auth.usedPercent >= 100 ? 'rate_limit_reached' : null
                }
              : null,
          rateLimitResetCredits:
            auth && auth.resets !== undefined
              ? {
                  availableCount: auth.resets,
                  credits: Array.from({ length: auth.resets }, (_, i) => ({
                    id: `fake-reset-${i}`,
                    resetType: 'codexRateLimits',
                    status: 'available',
                    grantedAt: now,
                    expiresAt: now + (i + 1) * 86400,
                    title: 'Full reset'
                  }))
                }
              : null,
          rateLimitsByLimitId: {}
        })
        return
      }
      if (method === 'account/rateLimitResetCredit/consume') {
        const auth = signIn() || {}
        append('fake-codex-reset-calls.jsonl', { codexHome, params: p })
        const outcome = !auth.resets
          ? 'noCredit'
          : auth.usedPercent >= 100
            ? 'reset'
            : 'nothingToReset'
        if (outcome === 'reset')
          fs.writeFileSync(
            path.join(codexHome, 'auth.json'),
            JSON.stringify({ ...auth, usedPercent: 0, resets: auth.resets - 1 })
          )
        result(id, { outcome })
        return
      }
      if (method === 'hooks/list') {
        result(id, {
          data: (p.cwds || []).map((cwd) => ({ cwd, warnings: [], ...gateHooks() }))
        })
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
      // CODEX§16
      if (method === 'account/login/start') {
        append('fake-codex-logins.jsonl', {
          type: p.type,
          accessToken: p.accessToken ?? null,
          accountId: p.chatgptAccountId ?? null
        })
        loginFromTheClient = { type: 'chatgpt', usedPercent: 10 }
        result(id, {})
        event('account/login/completed', { loginId: null, success: true, error: null })
        return
      }
      if (id !== undefined) result(id, {})
    }
  }
  const listen = argValue('--listen')
  if (listen) {
    const http = require('http')
    const { WebSocketServer } = require('ws')
    const requested = listen.replace(/^unix:\/\//, '')
    // CODEX§16
    if (fs.statSync(path.dirname(requested)).mode & 0o022) {
      console.error(
        'Error: socket parent must be owned by the user or root and prevent other users from replacing socket entries'
      )
      process.exit(1)
    }
    const short = `/tmp/fcx-${crypto.createHash('sha1').update(requested).digest('hex').slice(0, 12)}.sock`
    fs.rmSync(short, { force: true })
    const server = http.createServer((_req, res) => res.writeHead(404).end())
    const wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => {
      const receive = serve((line) => ws.send(line))
      ws.on('message', (data) => receive(String(data)))
    })
    process.on('SIGTERM', () => {})
    process.on('SIGHUP', () => {})
    server.listen(short, () => {
      fs.rmSync(requested, { force: true })
      fs.symlinkSync(short, requested)
    })
  } else {
    const receive = serve((line) => process.stdout.write(line + '\n'))
    readline.createInterface({ input: process.stdin }).on('line', receive)
    process.stdin.on('end', () => process.exit(0))
  }
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
  // CODEX§14
  let firstPrompt = argv.find(
    (arg, i) => !arg.startsWith('-') && !FLAGS_FOLLOWED_BY_A_VALUE.includes(argv[i - 1])
  )
  if (argv.includes('resume')) firstPrompt = undefined
  if (!url) {
    console.error('fake-codex needs --remote')
    process.exit(2)
  }
  const WebSocket = require('ws')
  const connectTo = () =>
    new WebSocket(url.startsWith('unix://') ? 'ws+unix://' + url.slice(7) + ':/' : url)
  let ws = connectTo()
  let leaving = false
  let id = 0
  let thread
  let turnId
  let working = false
  let approval
  let question
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
      codexHome: process.env.CODEX_HOME || null,
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
      cdpEndpoint: process.env.KOLOFT_BROWSER_CDP || null
    })
    process.stdout.write('\r\nCodex fixture ready ' + thread.id + '\r\n> ')
    const first = firstPrompt
    firstPrompt = undefined
    if (method === 'thread/start' && !flag('fake-codex-lazy'))
      await prompt(first ?? read('fake-codex-next-title', 'Codex fixture session'))
  }
  const exit = async () => {
    leaving = true
    if (thread) await send('thread/unsubscribe', { threadId: thread.id }).catch(() => {})
    ws.close()
  }
  const input = async (raw) => {
    const text = raw.trim()
    if (!text) return
    if (approval) {
      ws.send(
        JSON.stringify({
          id: approval,
          result: { decision: text.toLowerCase().startsWith('y') ? 'accept' : 'decline' }
        })
      )
      approval = undefined
    } else if (text === '/exit' || text === '/quit') await exit()
    else if (text === '/drop') ws.terminate()
    else if (text === '/new' || text === '/clear') await open('thread/start', { cwd })
    // CODEX§21
    else if (text === '/compact') await send('thread/compact/start', { threadId: thread.id })
    else if (text === '/fork') await open('thread/fork', { threadId: thread.id, cwd })
    else if (text.startsWith('/resume '))
      await open('thread/resume', { threadId: text.slice(8).trim(), cwd })
    else await prompt(text)
  }
  const onMessage = (bytes) => {
    const frame = JSON.parse(bytes.toString())
    if (frame.method === 'item/commandExecution/requestApproval') {
      approval = frame.id
      process.stdout.write('\r\nApprove command? [y/n] ')
    } else if (frame.method === 'item/tool/requestUserInput') {
      const [q] = frame.params.questions
      question = { id: frame.id, key: q.id, labels: q.options.map((o) => o.label) }
      process.stdout.write('\r\n' + q.question + ' ' + question.labels.join(' / ') + ' ')
      // CODEX§20
      const givesUpMs = Number(read('fake-codex-question-gives-up-ms')) || 0
      if (givesUpMs && !frame.params.isBlocking)
        setTimeout(() => {
          if (question?.id !== frame.id) return
          ws.send(JSON.stringify({ id: frame.id, result: { answers: {} } }))
          question = undefined
        }, givesUpMs)
    } else if (frame.method === 'item/completed' && /^(koloft|sh)-/.test(frame.params.item.id)) {
      const { aggregatedOutput, exitCode, id } = frame.params.item
      const said = aggregatedOutput.replace(/\r?\n/g, '\r\n')
      const tool = id.slice(0, id.indexOf('-'))
      process.stdout.write(`\r\n${said}[fake-codex] ${tool} exit=${exitCode}\r\n> `)
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
  }
  const initialize = async () => {
    await send('initialize', {
      clientInfo: { name: 'codex_cli_rs', version: VERSION_AT_KOLOFTS_MINIMUM },
      capabilities: { experimentalApi: true }
    })
    ws.send(JSON.stringify({ method: 'initialized' }))
  }
  // CODEX§34
  const reconnects = () => !leaving && !!thread && flag('fake-codex-reconnects')
  const attach = (socket, opened) => {
    socket.on('message', onMessage)
    socket.on('error', (error) => {
      if (reconnects()) return
      console.error(error.message)
      process.exit(1)
    })
    socket.on('close', () => {
      if (!reconnects()) process.exit(0)
      for (const waiting of pending.values()) waiting.reject(new Error('Reconnecting to server…'))
      pending.clear()
      process.stdout.write('\r\nReconnecting to server…\r\n')
      setTimeout(() => {
        ws = connectTo()
        attach(ws, async () => {
          try {
            await initialize()
            thread = (await send('thread/resume', { threadId: thread.id, excludeTurns: true }))
              .thread
            append('fake-codex-reconnects.jsonl', { pid: process.pid, sessionId: thread.id })
            process.stdout.write('Codex fixture reconnected ' + thread.id + '\r\n> ')
          } catch (error) {
            process.stdout.write(error.message + '\r\n')
            ws.terminate()
          }
        })
      }, 200)
    })
    socket.on('open', opened)
  }
  attach(ws, async () => {
    try {
      await initialize()
      const resume = argv.indexOf('resume')
      await open(
        resume >= 0 ? 'thread/resume' : 'thread/start',
        resume >= 0 ? { threadId: argv[resume + 1], cwd } : { cwd }
      )
      process.stdin.setRawMode?.(true)
      process.stdin.resume()
      const typeIn = (part) => {
        for (const ch of part) {
          // CODEX§3
          if (approval && ['y', '1', '\u001b'].includes(ch)) {
            const decision = ch === '\u001b' ? 'decline' : 'accept'
            ws.send(JSON.stringify({ id: approval, result: { decision } }))
            approval = undefined
            continue
          }
          // CODEX§20
          const picked = question?.labels[Number(ch) - 1]
          if (picked) {
            const answers = { [question.key]: { answers: [picked] } }
            ws.send(JSON.stringify({ id: question.id, result: { answers } }))
            question = undefined
            continue
          }
          if (ch === '\u0003') {
            if (working) void send('turn/interrupt', { threadId: thread.id, turnId })
            else void exit()
            return 'stop'
          }
          if (ch === '\r' || ch === '\n') {
            const line = typed
            typed = ''
            process.stdout.write('\r\n')
            void input(line).catch((error) => process.stdout.write(error.message + '\r\n'))
          } else if (ch === '\u007f') typed = typed.slice(0, -1)
          // CODEX§21
          else if (ch === '\u0015') typed = ''
          else if (ch === '\u001b' || ch === '\u0005') continue
          else {
            typed += ch
            process.stdout.write(ch)
          }
        }
      }
      let pasting = false
      process.stdin.on('data', (bytes) => {
        // CODEX§23
        for (const part of bytes.toString('utf8').split(/(\x1b\[20[01]~)/)) {
          if (part === '\x1b[200~' || part === '\x1b[201~') {
            pasting = part === '\x1b[200~'
          } else if (pasting) {
            typed += part
            process.stdout.write(part.replace(/\n/g, '\r\n'))
          } else if (typeIn(part) === 'stop') return
        }
      })
    } catch (error) {
      console.error(error.message)
      process.exit(1)
    }
  })
}
