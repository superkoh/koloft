#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const { spawnSync } = require('child_process')

const ESC = '\x1b'
const STATUS_ASK = `${ESC}]7501;?${ESC}\\`
const STATUS_ON = `${ESC}]7501;?:states=`
const argv = process.argv.slice(2)
const home = process.env.HOME
const museHome = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'muse')
const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'muse')
const sessionsDir = path.join(museHome, 'sessions', 'fake')
const registryDir = path.join(museHome, 'runtime', 'muse', 'sessions')
const pendingDir = path.join(museHome, 'fake-pending')
const trustFile = path.join(configDir, 'trust.json')
const authFile = path.join(configDir, 'auth.json')
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

const uuidv7 = () => {
  const hex = Date.now().toString(16).padStart(12, '0') + crypto.randomBytes(10).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

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

const sessionLog = (id) => {
  const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16)
  const d = new Date(ms)
  const p2 = (n) => String(n).padStart(2, '0')
  return path.join(
    museHome,
    'sessions',
    String(d.getFullYear()),
    p2(d.getMonth() + 1),
    p2(d.getDate()),
    id,
    'session.jsonl'
  )
}
const logRecord = (id, payloadType, payload) => {
  const log = sessionLog(id)
  fs.mkdirSync(path.dirname(log), { recursive: true })
  fs.appendFileSync(
    log,
    JSON.stringify({ recorded_at: Date.now() * 1000, payload_type: payloadType, payload }) + '\n'
  )
}

const pendingFile = (id) => path.join(pendingDir, id + '.json')
const pendingOf = (id) => {
  try {
    return JSON.parse(fs.readFileSync(pendingFile(id), 'utf8'))
  } catch {
    return { approvals: [], userInputs: [] }
  }
}

const signedIn = () => {
  if (process.env.META_API_KEY) return 'envKey'
  try {
    const meta = JSON.parse(fs.readFileSync(authFile, 'utf8')).providers?.meta
    return !meta ? 'loggedOut' : meta.access_token ? 'accountLogin' : 'apiKey'
  } catch {
    return 'loggedOut'
  }
}
const storeKey = (key) => {
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(
    authFile,
    JSON.stringify({ schema_version: 1, providers: { meta: { api_key: key.trim() } } }),
    { mode: 0o600 }
  )
}

if (argv[0] === '--version') {
  process.stdout.write('Muse Code 1.4.7 (1.4.7-R6101.1)\n')
  process.exit(0)
}

if (argv[0] === 'serve') serve()
else if (argv[0] === 'auth') {
  let key = ''
  process.stdin.on('data', (chunk) => (key += chunk))
  process.stdin.on('end', () => {
    storeKey(key)
    process.stdout.write('credentials saved for provider meta\n')
  })
} else if (argv[0] === 'login') {
  process.stdout.write('Open this page to sign in: https://auth.example/device  code: FAKE-CODE\n')
  storeKey('fake-login')
  process.stdout.write('Signed in.\n')
} else tui()

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
    if (msg.method === 'account/read') return reply(msg.id, { state: signedIn() })
    if (msg.method === 'approval/listPending') return reply(msg.id, pendingOf(msg.params.sessionId))
    if (msg.method === 'session/list') {
      append('fake-muse-listings.jsonl', { at: now() })
      const sessions = all()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((s) => ({
          sessionId: s.id,
          path: sessionLog(s.id),
          status: 'notLoaded',
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          workspaceRoot: s.forkedFrom ? null : s.cwd,
          ...(s.forkedFrom && { forkedFrom: { sessionId: s.forkedFrom } }),
          kind: 'root',
          name: 'fake-name',
          title: s.title,
          firstUserPrompt: s.title
        }))
      return reply(msg.id, { sessions, nextCursor: null })
    }
    if (msg.method === 'session/read') {
      if (!echo && signedIn() === 'loggedOut')
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
    if (
      [
        '--model',
        '--reasoning-effort',
        '--approval-mode',
        '--approval-judge',
        '--permission-profile',
        '--sandbox-network'
      ].includes(a)
    )
      flags[a] = argv[++i]
    else if (a === '--trust-workspace') flags.trust = true
    else if (a === '--no-session-log') flags.noLog = true
    else rest.push(a)
  }
  let resumeId = rest[0] === 'resume' ? rest[1] : undefined
  const firstPrompt = rest[0] === 'resume' ? undefined : rest[0]
  const hooks = (() => {
    try {
      return JSON.parse(fs.readFileSync(process.env.TBH_MANAGED_HOOKS_PATH, 'utf8')).hooks ?? {}
    } catch {
      return {}
    }
  })()
  let statusOn = false
  let session
  let started = false
  let startSource = 'startup'
  let blocked
  let current
  let typed = ''
  const fire = (event, input) =>
    (hooks[event] ?? []).flatMap((group) =>
      (group.hooks ?? []).map(
        (h) =>
          spawnSync('/bin/sh', ['-c', h.command], {
            input: JSON.stringify({
              hook_event_name: event,
              cwd: process.cwd(),
              session_id: session.id,
              transcript_path: null,
              ...input
            }),
            env: {
              HOME: home,
              PATH: process.env.PATH,
              PWD: process.cwd(),
              TERM: 'xterm-256color',
              MUSE_SESSION_ID: session.id,
              MUSE_THREAD_ID: input.session_id ?? session.id
            },
            encoding: 'utf8'
          }).stdout
      )
    )
  const denial = (outs) =>
    outs
      .map((out) => {
        try {
          return JSON.parse(out).hookSpecificOutput
        } catch {
          return undefined
        }
      })
      .find((o) => o?.permissionDecision === 'deny')
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
    const resumed = id && load(id)
    session = resumed || {
      id: uuidv7(),
      cwd: fs.realpathSync(process.cwd()),
      title: null,
      createdAt: now(),
      updatedAt: now(),
      items: []
    }
    started = !!resumed
    if (flags.noLog) {
      process.stdout.write(`Muse fixture ready (no session log)\r\n`)
      return inputBox()
    }
    save(session)
    register()
    append('fake-muse-calls.jsonl', {
      pid: process.pid,
      argv,
      cwd: process.cwd(),
      sessionId: session.id,
      pathHead: (process.env.PATH || '').split(':')[0],
      configHome: process.env.XDG_CONFIG_HOME || null,
      credentials: process.env.TBH_CREDENTIAL_BACKEND || null
    })
    process.stdout.write(`Muse fixture ready ${session.id}\r\n`)
    inputBox()
  }
  const inputBox = () => {
    const rule = '─'.repeat(40)
    process.stdout.write(
      `${rule}\r\n❯\r\n${rule}\r\n  fake-model · ${path.basename(process.cwd())}\r\n`
    )
  }
  const commit = (turnId, text) => {
    session.items.push({
      itemId: crypto.randomUUID(),
      kind: 'agentMessage',
      text,
      recordedAt: now()
    })
    save(session)
    logRecord(session.id, 'runtime.session', {
      kind: 'run',
      run_id: turnId,
      event: { kind: 'assistant_message_committed', text }
    })
    process.stdout.write(`${text}\r\n`)
  }
  // MUSE§9
  const stopBlock = (outs) => {
    for (const out of outs) {
      try {
        const parsed = JSON.parse(out)
        if (parsed.decision === 'block') return out
      } catch {}
    }
    return undefined
  }
  const say = (turnId, text, prompt) => {
    commit(turnId, text)
    inputBox()
    const stop = (last, active) =>
      fire('Stop', {
        turn_id: turnId,
        last_assistant_message: last,
        prompt,
        stop_hook_active: active
      })
    const blocked = stopBlock(stop(text, false))
    if (blocked) {
      append('fake-muse-prompt-context.jsonl', { sessionId: session.id, out: blocked })
      const reason = JSON.parse(blocked).reason
      commit(turnId, `Stop said: ${reason}`)
      stop(`Stop said: ${reason}`, true)
    }
    status('state=done:app=muse')
  }
  const turn = (text) => {
    if (!started) {
      started = true
      for (const out of fire('SessionStart', { source: startSource }))
        if (out) append('fake-muse-told.jsonl', { sessionId: session.id, out })
    }
    const turnId = crypto.randomUUID()
    status('state=working:app=muse')
    for (const out of fire('UserPromptSubmit', { prompt: text, turn_id: turnId }))
      if (out) append('fake-muse-prompt-context.jsonl', { sessionId: session.id, out })
    session.items.push({
      itemId: crypto.randomUUID(),
      kind: 'userMessage',
      text,
      recordedAt: now()
    })
    session.title ||= text
    session.updatedAt = now()
    save(session)
    logRecord(session.id, 'runtime.command_intake.received', {
      record: { command: { kind: 'turn_submit', prompt: text } }
    })
    return turnId
  }
  const later = (fn) => setTimeout(fn, Number(read('fake-muse-delay', '300')))
  const block = (kind, pending, onKey) => {
    fs.mkdirSync(pendingDir, { recursive: true })
    fs.writeFileSync(pendingFile(session.id), JSON.stringify(pending))
    blocked = (key) => {
      if (!onKey(key)) return
      blocked = undefined
      fs.rmSync(pendingFile(session.id), { force: true })
    }
    status(`state=blocked:app=muse:kind=${kind}`)
  }
  const command = (text) => {
    if (text.startsWith('/write ')) {
      const target = text.slice('/write '.length).trim()
      const turnId = turn(text)
      const denied = denial(
        fire('PreToolUse', {
          turn_id: turnId,
          tool_name: 'write_file',
          tool_input: { path: target, content: 'written by fake muse\n' }
        })
      )
      if (denied)
        return later(() => say(turnId, `Blocked: ${denied.permissionDecisionReason}`, text))
      fs.writeFileSync(path.resolve(process.cwd(), target), 'written by fake muse\n')
      fire('PostToolUse', {
        turn_id: turnId,
        tool_name: 'write_file',
        tool_input: { path: target },
        tool_response: {
          filePath: target,
          structuredPatch: [
            { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+written by fake muse'] }
          ]
        }
      })
      return later(() => say(turnId, `Wrote ${target}`, text))
    }
    if (text === '/approve') {
      const turnId = turn(text)
      return block(
        'permission',
        {
          approvals: [{ approvalId: 'approval-1', rawArgs: { command: 'ls -la' } }],
          userInputs: []
        },
        (key) => {
          if (key !== 'y' && key !== ESC) return false
          status('state=working:app=muse')
          later(() => say(turnId, key === 'y' ? 'Ran: ls -la' : 'Denied: ls -la', text))
          return true
        }
      )
    }
    if (text === '/ask') {
      const turnId = turn(text)
      const options = [{ label: 'Red' }, { label: 'Blue' }]
      let picked = 0
      return block(
        'question',
        {
          approvals: [],
          userInputs: [
            {
              userInputId: 'input-1',
              questions: [
                { id: 'color', question: 'Which colour?', options, selection: { mode: 'single' } }
              ]
            }
          ]
        },
        (key) => {
          if (/^[1-9]$/.test(key)) picked = Number(key) - 1
          if (key !== '\r' && key !== ESC) return false
          status('state=working:app=muse')
          const answer = key === ESC ? 'nothing' : options[picked]?.label
          later(() => say(turnId, `Picked: ${answer}`, text))
          return true
        }
      )
    }
    if (text === '/subagent') {
      const turnId = turn(text)
      const child = crypto.randomUUID()
      const sub = crypto.randomUUID()
      fire('SubagentStart', { session_id: child, child_session_id: child, subagent_id: sub })
      say(turnId, 'A subagent is on it', text)
      return setTimeout(
        () => {
          fire('SubagentStop', { session_id: child, child_session_id: child, subagent_id: sub })
          say(crypto.randomUUID(), 'Subagent done')
        },
        Number(read('fake-muse-subagent-ms', '1500'))
      )
    }
    if (text === '/bg') {
      const turnId = turn(text)
      const work = `work.v2.managed_bash.sha256.${crypto.randomBytes(8).toString('hex')}`
      fire('PostToolUse', {
        turn_id: turnId,
        tool_name: 'bash',
        tool_input: { command: 'sleep 2; echo BG-DONE' },
        tool_response: JSON.stringify({ execution_state: 'background_running', work_id: work })
      })
      say(turnId, 'Started in the background', text)
      return setTimeout(
        () => {
          logRecord(session.id, 'runtime.session', {
            kind: 'run',
            event: {
              kind: 'inbox_item_queued',
              registered_work_id: work,
              source: { source: 'background_task_terminal' }
            }
          })
          const wake = crypto.randomUUID()
          say(wake, 'Background work finished')
        },
        Number(read('fake-muse-bg-ms', '2000'))
      )
    }
    if (text === '/fork') {
      const child = {
        ...session,
        id: uuidv7(),
        forkedFrom: session.id,
        createdAt: now(),
        updatedAt: now()
      }
      save(child)
      process.stdout.write(`Fork created: ${child.id}\r\nSource session stays active.\r\n`)
      return
    }
    if (text === '/usage') {
      const used = JSON.parse(read('fake-muse-quota.json', '{"current":12,"weekly":34}'))
      const box = [
        'Session usage',
        '',
        '  Turns         0',
        ...(signedIn() === 'accountLogin'
          ? [
              '',
              'Subscription · Muse Code High Usage',
              `  Current        ${used.current}% used · Resets at 4:11 AM`,
              `  Weekly         ${used.weekly}% used · Resets Oct 18 at 5:00 PM`,
              '  as of 12:31 AM'
            ]
          : [])
      ]
      const width = 54
      process.stdout.write(
        [
          `┌${'─'.repeat(width)}┐`,
          ...box.map((l) => `│  ${l.padEnd(width - 2)}│`),
          `└${'─'.repeat(width)}┘`
        ].join('\r\n') + '\r\n'
      )
      inputBox()
      return
    }
    if (text.startsWith('/rename ')) {
      logRecord(session.id, 'session.name.changed', {
        new_name: text.slice('/rename '.length).trim(),
        source: 'user'
      })
      return
    }
    return false
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
    if (firstPrompt) {
      const turnId = turn(firstPrompt)
      later(() => say(turnId, `echo: ${firstPrompt}`, firstPrompt))
    }
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
    if (text === '/exit') {
      status('state=clear')
      process.exit(0)
    }
    if (text === '/clear' || text === '/new' || text.startsWith('/resume ')) {
      unregister()
      status('state=clear')
      resumeId = text.startsWith('/resume ') ? text.slice('/resume '.length).trim() : undefined
      startSource = text === '/clear' ? 'clear' : 'startup'
      open(resumeId)
      status('state=idle:app=muse')
      return
    }
    if (text === '/block') {
      blocked = () => {
        blocked = undefined
        status('state=done:app=muse')
      }
      return status('state=blocked:app=muse:kind=permission')
    }
    if (text.startsWith('!')) {
      status('state=working:app=muse')
      return setTimeout(() => status('state=error:app=muse'), 100)
    }
    if (!text || command(text) !== false) return
    const turnId = turn(text)
    later(() => say(turnId, `echo: ${text}`, text))
  }
  process.stdout.write(STATUS_ASK)
  if (asking) process.stdout.write('Do you trust this workspace? 1 Trust and continue 2 Quit\r\n')
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (chunk) => {
    let text = chunk.toString('utf8')
    if (text.includes(STATUS_ON)) {
      statusOn = true
      text = text.replace(/\x1b\]7501;\?:[^\x07\x1b]*(\x07|\x1b\\)/g, '')
      if (current) status(current)
    }
    for (const ch of text.replace(/\x1b\[20[01]~/g, '')) {
      if (blocked) {
        blocked(ch === '\n' ? '\r' : ch)
        continue
      }
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
