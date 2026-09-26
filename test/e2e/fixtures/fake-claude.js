#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const cp = require('child_process')
const readline = require('readline')

const LIVE_EXECPATH_DIFFERING_FROM_TRANSCRIPT_VERSION = '/fake/versions/8.8.8'
const TRANSCRIPT_VERSION_THAT_LOSES_TO_LIVE = '9.9.9-fake'
const PRICED_MODEL_ID = 'claude-opus-4-8'

const FULL_LENGTH_108_CHAR_SETUP_TOKEN =
  'sk-ant-oat01-A1b2C3d4E5f6G7h8I9j0A1b2C3d4E5f6G7h8I9j0A1b2C3d4E5f6G7h8I9j0A1b2C3d4E5f6G7h8I9j0K1L2M3N4O5P6Q7R'
const BROWSER_ROUND_TRIP_OUTLASTING_OPEN_DELIVERY_MS = 1500
const sleepBlockingMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// CC§9
const rawArgv = process.argv.slice(2)
const dashDashAt = rawArgv.indexOf('--')
const argv = dashDashAt >= 0 ? rawArgv.slice(0, dashDashAt) : rawArgv
const firstPrompt = dashDashAt >= 0 ? rawArgv.slice(dashDashAt + 1).join(' ') : null
const argVal = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

// CC§7
if (argv[0] === 'setup-token') {
  const tok = process.env.KOLOFT_FAKE_SETUP_TOKEN || FULL_LENGTH_108_CHAR_SETUP_TOKEN
  const cols = process.stdout.columns || 80
  const inkHardWrappedToken = tok.match(new RegExp(`.{1,${cols}}`, 'g')).join('\r\n')
  const authUrl = process.env.KOLOFT_FAKE_SETUP_URL
  if (authUrl) {
    process.stdout.write(`\r\nBrowser didn't open? Visit: ${authUrl}\r\n`)
    require('child_process').spawnSync('/bin/sh', ['-c', 'open "$0"', authUrl], {
      stdio: 'ignore'
    })
    sleepBlockingMs(BROWSER_ROUND_TRIP_OUTLASTING_OPEN_DELIVERY_MS)
  }
  process.stdout.write(
    `\r\nPaste this token into your environment:\r\n\r\n${inkHardWrappedToken}\r\n\r\n`
  )
  process.exit(0)
}

let sessionId = argVal('--session-id') || argVal('--resume') || require('crypto').randomUUID()
const settingsPath = argVal('--settings')
// CC§2
const launchCwd = fs.realpathSync(process.cwd())
const home = process.env.HOME || require('os').homedir()

function writeCallLog(effCwd) {
  const callLog = process.env.KOLOFT_FAKE_CLAUDE_LOG || path.join(home, 'fake-claude-calls.jsonl')
  try {
    fs.appendFileSync(
      callLog,
      JSON.stringify({
        pid: process.pid,
        argv: rawArgv,
        cwd: launchCwd,
        effectiveCwd: effCwd,
        sessionId,
        firstPrompt,
        ts: Date.now(),
        oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
        apiKey: process.env.ANTHROPIC_API_KEY || null,
        cdpEndpoint: process.env.KOLOFT_BROWSER_CDP || null,
        playwrightMcpEndpoint: process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT || null,
        playwrightCliSession: process.env.PLAYWRIGHT_CLI_SESSION || null
      }) + '\n'
    )
  } catch {}
}

try {
  const raw = fs.readFileSync(path.join(home, 'fake-claude-exit'), 'utf8').trim()
  writeCallLog(launchCwd)
  process.stdout.write('\r\n[fake-claude] fatal: E2E_EARLY_EXIT simulated launch failure\r\n')
  const code = Number(raw)
  process.exit(Number.isFinite(code) ? code : 1)
} catch {}

if (fs.existsSync(path.join(home, 'fake-claude-hang'))) {
  writeCallLog(launchCwd)
  process.stdout.write('\r\n[fake-claude] hanging: never binds\r\n')
  setInterval(() => {}, 1 << 30)
  return
}

let effectiveCwd = launchCwd
const wtName = argVal('-w')

// CC§3

function makeWorktree(name, fatal = false) {
  const wtRel = path.join('.claude', 'worktrees', name)
  const wtDir = path.join(launchCwd, wtRel)
  if (!fs.existsSync(wtDir)) {
    try {
      cp.execSync(
        `git worktree add ${JSON.stringify(wtRel)} -b ${JSON.stringify('worktree-' + name)}`,
        { cwd: launchCwd, stdio: 'pipe' }
      )
    } catch {
      try {
        cp.execSync(
          `git worktree add ${JSON.stringify(wtRel)} ${JSON.stringify('worktree-' + name)}`,
          { cwd: launchCwd, stdio: 'pipe' }
        )
      } catch (err) {
        if (!fatal) return null
        writeCallLog(launchCwd)
        process.stdout.write(`\r\n[fake-claude] worktree add failed: ${String(err)}\r\n`)
        process.exit(1)
      }
    }
  }
  return fs.realpathSync(wtDir)
}

// CC§9
function seededTrustRefuses(dir) {
  let projects
  try {
    projects = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).projects ?? {}
  } catch {
    return false
  }
  for (let p = fs.realpathSync(dir); ; p = path.dirname(p)) {
    if (projects[p]?.hasTrustDialogAccepted === true) return false
    if (path.dirname(p) === p) return true
  }
}

if (wtName && seededTrustRefuses(launchCwd)) {
  process.stdout.write(
    'Error creating worktree: Workspace trust not yet accepted. Run `claude` once in this ' +
      'directory and accept the trust dialog, then retry with --worktree.\r\n'
  )
  process.exit(1)
}

if (wtName) effectiveCwd = makeWorktree(wtName, true)
let cwd = effectiveCwd

const encodeCwd = (c) => c.replace(/[^a-zA-Z0-9]/g, '-')
const slugDir = (c) => path.join(home, '.claude', 'projects', encodeCwd(c))
// CC§2
const projDir = slugDir(wtName ? launchCwd : cwd)
fs.mkdirSync(projDir, { recursive: true })
if (wtName) fs.mkdirSync(slugDir(cwd), { recursive: true })

// CC§3
function existingTranscript(id) {
  const root = path.join(home, '.claude', 'projects')
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, id + '.jsonl')
      if (fs.existsSync(f)) return f
    }
  } catch {}
  return null
}
const resumeId = argVal('--resume')
let transcript =
  (resumeId && existingTranscript(resumeId)) || path.join(projDir, sessionId + '.jsonl')

writeCallLog(cwd)

function delayMs() {
  try {
    const v = fs.readFileSync(path.join(home, 'fake-claude-delay'), 'utf8').trim()
    if (v) return Number(v) || 0
  } catch {}
  return Number(process.env.KOLOFT_FAKE_START_DELAY_MS || 0) || 0
}

function nextFreshLaunchTitleFromFile() {
  if (argVal('--resume')) return null
  const f = path.join(home, 'fake-claude-next-title')
  try {
    const v = fs.readFileSync(f, 'utf8').trim()
    fs.unlinkSync(f)
    if (v) return v
  } catch {}
  return null
}

const ONLY_START_SOURCE_BINDSESSION_SEEDS_NO_STATUS_FOR = 'compact'
const SECOND_STOP_AFTER_MS_OUTLASTING_A_MISSED_WATCH_POLL = 5000
const MID_TURN_WRITE_HOLD_MS_OUTLASTING_500MS_JSONL_POLL = 2500

let resolvedTitle = null
function sessionTitle() {
  if (resolvedTitle) return resolvedTitle
  return (resolvedTitle = resolveSessionTitle())
}
function resolveSessionTitle() {
  try {
    const prev = fs.readFileSync(transcript, 'utf8').split('\n')
    for (let i = prev.length - 1; i >= 0; i--) {
      if (!prev[i]) continue
      try {
        const rec = JSON.parse(prev[i])
        if (rec && rec.type === 'ai-title' && rec.aiTitle) return rec.aiTitle
      } catch {}
    }
  } catch {}
  return (
    nextFreshLaunchTitleFromFile() || process.env.KOLOFT_FAKE_TITLE || 'Fake session: project notes'
  )
}

let hooks = {}
let statusLine = null
if (settingsPath) {
  try {
    const injected = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    hooks = injected.hooks || {}
    statusLine = injected.statusLine || null
  } catch {}
}
const EVENT_KEY = {
  start: 'SessionStart',
  end: 'SessionEnd',
  prompt: 'UserPromptSubmit',
  stop: 'Stop',
  notify: 'Notification'
}
function fireHook(event, payload) {
  const cmd = hooks?.[EVENT_KEY[event]]?.[0]?.hooks?.[0]?.command
  if (!cmd) return
  // CC§1
  const body = 'session_id' in payload ? payload : { ...payload, session_id: sessionId }
  try {
    cp.execSync(cmd, {
      input: JSON.stringify(body),
      stdio: ['pipe', 'ignore', 'ignore'],
      // CC§1
      env: { ...process.env, CLAUDE_CODE_EXECPATH: LIVE_EXECPATH_DIFFERING_FROM_TRANSCRIPT_VERSION }
    })
  } catch {}
}

function append(lines) {
  fs.appendFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

function git(args, at) {
  try {
    return cp.execSync(`git ${args}`, { cwd: at, stdio: 'pipe' }).toString().trim()
  } catch {
    return ''
  }
}

// CC§2
function appendWorktreeState() {
  append([
    {
      type: 'worktree-state',
      worktreeSession: {
        originalCwd: launchCwd,
        preEnterOriginalCwd: launchCwd,
        worktreePath: cwd,
        worktreeName: wtName,
        worktreeBranch: 'worktree-' + wtName,
        originalBranch: git('symbolic-ref --short HEAD', launchCwd) || 'main',
        originalHeadCommit: git('rev-parse HEAD', launchCwd),
        sessionId
      }
    }
  ])
}

// CC§6 PLATFORM§36
function renderStatuslineWithoutBlockingSessionStart() {
  if (!statusLine || statusLine.type !== 'command' || !statusLine.command) return
  const payload = {
    hook_event_name: 'Status',
    session_id: sessionId,
    transcript_path: transcript,
    cwd,
    model: { id: PRICED_MODEL_ID, display_name: 'Opus 4.8' },
    effort: { level: 'xhigh' },
    workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
    version: TRANSCRIPT_VERSION_THAT_LOSES_TO_LIVE,
    cost: {
      total_cost_usd: 0.01,
      total_duration_ms: 1000,
      total_api_duration_ms: 500,
      total_lines_added: 1,
      total_lines_removed: 0
    },
    context_window: {
      total_input_tokens: 42000,
      total_output_tokens: 350,
      context_window_size: 200000,
      current_usage: {
        input_tokens: 8,
        output_tokens: 350,
        cache_creation_input_tokens: 12000,
        cache_read_input_tokens: 30000
      },
      used_percentage: 21,
      remaining_percentage: 79
    }
  }
  try {
    const child = cp.exec(
      statusLine.command,
      { env: { ...process.env, COLUMNS: '120' }, timeout: 20000, encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout) return
        try {
          fs.writeFileSync(path.join(home, 'fake-claude-statusline.out'), stdout)
        } catch {}
      }
    )
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  } catch {}
}

function taskNotification(toolUseId, status, summary) {
  return (
    `<task-notification>\n<task-id>t_${toolUseId}</task-id>\n` +
    `<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n` +
    `<summary>${summary}</summary>\n</task-notification>`
  )
}

let uniqueAssistantIdSeq = 0
function usageMeta() {
  uniqueAssistantIdSeq += 1
  return {
    id: `msg_fake_${uniqueAssistantIdSeq}`,
    requestId: `req_fake_${uniqueAssistantIdSeq}`,
    model: PRICED_MODEL_ID,
    usage: {
      input_tokens: 8,
      output_tokens: 350,
      cache_creation_input_tokens: 12000,
      cache_read_input_tokens: 30000
    }
  }
}

function noStatus() {
  return fs.existsSync(path.join(home, 'fake-claude-no-status'))
}

// CC§2
function lazyTranscript() {
  return !resumeId && fs.existsSync(path.join(home, 'fake-claude-lazy'))
}

// CC§1
const startCwd = resumeId ? launchCwd : cwd

function startupTurn() {
  if (noStatus()) {
    fs.writeFileSync(transcript, '')
    fireHook('start', {
      session_id: sessionId,
      transcript_path: transcript,
      cwd: startCwd,
      hook_event_name: 'SessionStart',
      source: ONLY_START_SOURCE_BINDSESSION_SEEDS_NO_STATUS_FOR
    })
    process.stdout.write(`\r\n[fake-claude] session ${sessionId} bound, no status\r\n> `)
    return
  }

  if (lazyTranscript()) {
    fireHook('start', {
      session_id: sessionId,
      transcript_path: transcript,
      cwd: startCwd,
      hook_event_name: 'SessionStart',
      source: 'startup'
    })
    process.stdout.write(`\r\n[fake-claude] session ${sessionId} bound, no transcript yet\r\n> `)
    return
  }

  fireHook('start', {
    session_id: sessionId,
    transcript_path: transcript,
    cwd: startCwd,
    hook_event_name: 'SessionStart',
    source: 'startup'
  })
  if (wtName) appendWorktreeState()

  // ADR-0020
  if (firstPrompt) {
    setImmediate(() => handleLine(firstPrompt))
    renderStatuslineWithoutBlockingSessionStart()
    process.stdout.write(`\r\n[fake-claude] session ${sessionId} ready in ${cwd}\r\n> `)
    return
  }

  const noteRel = 'NOTES.md'
  const noteBody = '# Session notes\n\nWritten by the fake claude session for the E2E run.\n'
  fs.writeFileSync(path.join(cwd, noteRel), noteBody)
  const meta = usageMeta()
  append([
    { type: 'user', message: { role: 'user', content: 'Set up the project notes' }, cwd },
    { type: 'ai-title', aiTitle: sessionTitle() },
    { type: 'summary', summary: sessionTitle() },
    {
      type: 'assistant',
      version: TRANSCRIPT_VERSION_THAT_LOSES_TO_LIVE,
      requestId: meta.requestId,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        id: meta.id,
        model: meta.model,
        content: [
          { type: 'text', text: 'Creating NOTES.md.' },
          { type: 'tool_use', name: 'Write', input: { file_path: noteRel, content: noteBody } }
        ],
        usage: meta.usage
      },
      cwd
    }
  ])
  fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
  fireHook('stop', { hook_event_name: 'Stop' })
  renderStatuslineWithoutBlockingSessionStart()

  process.stdout.write(`\r\n[fake-claude] session ${sessionId} ready in ${cwd}\r\n> `)
}

const startDelay = delayMs()
if (startDelay > 0) {
  process.stdout.write(`\r\n[fake-claude] delayed bind in ${startDelay}ms\r\n`)
  setTimeout(startupTurn, startDelay)
} else {
  startupTurn()
}

function shutdown(reason) {
  fireHook('end', { session_id: sessionId, transcript_path: transcript, cwd, reason })
  process.exit(0)
}

function dirtyCount() {
  return git('status --porcelain', cwd).split('\n').filter(Boolean).length
}

function removeWorktree() {
  git(`worktree remove --force ${JSON.stringify(cwd)}`, launchCwd)
  git(`branch -D ${JSON.stringify('worktree-' + wtName)}`, launchCwd)
}

let worktreeChoicePending = false
// CC§4
function exitSession() {
  if (!wtName) return shutdown('prompt_input_exit')
  const dirty = dirtyCount()
  if (!dirty) {
    removeWorktree()
    return shutdown('prompt_input_exit')
  }
  worktreeChoicePending = true
  process.stdout.write(
    `\r\nExiting worktree session\r\n` +
      `You have ${dirty} uncommitted file(s) in this worktree\r\n` +
      `1. Keep worktree\r\n` +
      `2. Remove worktree\r\n> `
  )
}

// CC§7 PLATFORM§2
function openEnvRoutingPastShimToRecordingFakeOpen() {
  const parts = (process.env.PATH || '').split(':').filter(Boolean)
  const isShimDir = (d) => {
    try {
      return fs.readFileSync(path.join(d, 'open'), 'utf8').includes('koloft open shim')
    } catch {
      return false
    }
  }
  const selfDir = path.dirname(process.argv[1] || '')
  const PATH = [...parts.filter(isShimDir), selfDir, ...parts].join(':')
  return { ...process.env, PATH }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', handleLine)
function handleLine(line) {
  const text = line.trim()
  if (worktreeChoicePending) {
    // CC§4
    if (text === '2') removeWorktree()
    return shutdown('prompt_input_exit')
  }
  if (text === '/exit' || text === 'exit' || text === '/quit') return exitSession()
  // CC§1 CC§2
  if (text === '/clear') {
    fireHook('end', { session_id: sessionId, transcript_path: transcript, cwd, reason: 'clear' })
    sessionId = require('crypto').randomUUID()
    transcript = path.join(projDir, sessionId + '.jsonl')
    fs.writeFileSync(transcript, '')
    fireHook('start', {
      session_id: sessionId,
      transcript_path: transcript,
      cwd,
      hook_event_name: 'SessionStart',
      source: 'clear'
    })
    process.stdout.write(`\r\n[fake-claude] cleared -> session ${sessionId}\r\n> `)
    return
  }
  // CC§2 CC§4
  if (text.startsWith('/enter-worktree ') || text === '/exit-worktree') {
    const entering = text !== '/exit-worktree'
    const name = entering ? text.slice('/enter-worktree '.length).trim() : ''
    if (entering && !name) return void process.stdout.write('> ')
    const dest = entering ? makeWorktree(name) : launchCwd
    if (!dest) return void process.stdout.write('> ')
    const destDir = slugDir(dest)
    fs.mkdirSync(destDir, { recursive: true })
    const moved = path.join(destDir, path.basename(transcript))
    if (fs.existsSync(transcript)) fs.renameSync(transcript, moved)
    else fs.writeFileSync(moved, '')
    transcript = moved
    if (entering) cwd = dest
    append([
      { type: 'relocated', sessionId, relocatedCwd: dest },
      {
        type: 'worktree-state',
        sessionId,
        worktreeSession: entering
          ? {
              originalCwd: launchCwd,
              preEnterOriginalCwd: launchCwd,
              worktreePath: dest,
              worktreeName: name,
              worktreeBranch: 'worktree-' + name,
              originalBranch: 'main',
              originalHeadCommit: git('rev-parse HEAD', launchCwd),
              sessionId
            }
          : null
      }
    ])
    process.stdout.write(`\r\n[fake-claude] ${entering ? 'entered' : 'left'} ${dest}\r\n> `)
    return
  }
  // CC§1
  if (text === '/compact') {
    fireHook('end', { session_id: sessionId, transcript_path: transcript, cwd, reason: 'other' })
    fireHook('start', {
      session_id: sessionId,
      transcript_path: transcript,
      cwd,
      hook_event_name: 'SessionStart',
      source: 'compact'
    })
    process.stdout.write(`\r\n[fake-claude] compacted -> session ${sessionId}\r\n> `)
    return
  }
  // CC§1
  if (text.startsWith('/resume ')) {
    const target = text.slice('/resume '.length).trim()
    if (!target) return void process.stdout.write('> ')
    fireHook('end', { session_id: sessionId, transcript_path: transcript, cwd, reason: 'other' })
    sessionId = target
    transcript = path.join(projDir, sessionId + '.jsonl')
    if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '')
    fireHook('start', {
      session_id: sessionId,
      transcript_path: transcript,
      cwd,
      hook_event_name: 'SessionStart',
      source: 'resume'
    })
    process.stdout.write(`\r\n[fake-claude] resumed session ${sessionId}\r\n> `)
    return
  }
  // CC§8
  if (text === '/bg-work') {
    fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
    const bgToolUseId = 'toolu_bg_e2e'
    const meta = usageMeta()
    append([
      { type: 'user', message: { role: 'user', content: text }, cwd },
      {
        type: 'assistant',
        version: TRANSCRIPT_VERSION_THAT_LOSES_TO_LIVE,
        requestId: meta.requestId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          id: meta.id,
          model: meta.model,
          content: [{ type: 'tool_use', id: bgToolUseId, name: 'Agent', input: { prompt: 'bg' } }],
          usage: meta.usage
        },
        cwd
      },
      {
        type: 'user',
        timestamp: new Date().toISOString(),
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'abg_e2e' },
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: bgToolUseId, content: 'Spawned successfully.' }
          ]
        },
        cwd
      }
    ])
    fireHook('stop', { hook_event_name: 'Stop' })

    const subDir = path.join(projDir, sessionId, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    const subFile = path.join(subDir, 'agent-abg_e2e.jsonl')
    let steps = 0
    const iv = setInterval(() => {
      steps += 1
      fs.appendFileSync(
        subFile,
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date().toISOString(),
          agentId: 'abg_e2e',
          isSidechain: true,
          message: { role: 'assistant', content: [{ type: 'text', text: `bg step ${steps}` }] }
        }) + '\n'
      )
      if (steps >= 10) {
        clearInterval(iv)
        const done = usageMeta()
        append([
          {
            type: 'queue-operation',
            operation: 'enqueue',
            timestamp: new Date().toISOString(),
            content: taskNotification(bgToolUseId, 'completed', 'background work done')
          },
          {
            type: 'attachment',
            timestamp: new Date().toISOString(),
            attachment: {
              type: 'queued_command',
              prompt: taskNotification(bgToolUseId, 'completed', 'background work done'),
              commandMode: 'task-notification'
            },
            cwd
          },
          {
            type: 'assistant',
            version: TRANSCRIPT_VERSION_THAT_LOSES_TO_LIVE,
            requestId: done.requestId,
            timestamp: new Date().toISOString(),
            message: {
              role: 'assistant',
              id: done.id,
              model: done.model,
              content: [{ type: 'text', text: 'Background work finished.' }],
              usage: done.usage
            },
            cwd
          }
        ])
        fireHook('stop', { hook_event_name: 'Stop' })
        process.stdout.write('[fake-claude] bg-work finished\r\n> ')
      }
    }, 500)
    process.stdout.write('[fake-claude] bg-work running\r\n> ')
    return
  }
  // CC§8
  if (text === '/bg-reported') {
    fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
    const meta = usageMeta()
    append([
      { type: 'user', message: { role: 'user', content: text }, cwd },
      {
        type: 'assistant',
        version: TRANSCRIPT_VERSION_THAT_LOSES_TO_LIVE,
        requestId: meta.requestId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          id: meta.id,
          model: meta.model,
          content: [{ type: 'text', text: 'kicked it off' }],
          usage: meta.usage
        },
        cwd
      }
    ])
    fireHook('stop', {
      hook_event_name: 'Stop',
      background_tasks: [
        { id: 'arep_e2e', type: 'subagent', status: 'running', description: 'reported work' }
      ]
    })
    setTimeout(() => {
      const done = usageMeta()
      append([
        {
          type: 'assistant',
          version: TRANSCRIPT_VERSION_THAT_LOSES_TO_LIVE,
          requestId: done.requestId,
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            id: done.id,
            model: done.model,
            content: [{ type: 'text', text: 'reported work finished.' }],
            usage: done.usage
          },
          cwd
        }
      ])
      fireHook('stop', { hook_event_name: 'Stop', background_tasks: [] })
      process.stdout.write('[fake-claude] bg-reported finished\r\n> ')
    }, SECOND_STOP_AFTER_MS_OUTLASTING_A_MISSED_WATCH_POLL)
    process.stdout.write('[fake-claude] bg-reported running\r\n> ')
    return
  }
  // CC§8
  if (text === '/bg-monitor') {
    fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
    const monToolUseId = 'toolu_monitor_e2e'
    const meta = usageMeta()
    append([
      { type: 'user', message: { role: 'user', content: text }, cwd },
      {
        type: 'assistant',
        version: TRANSCRIPT_VERSION_THAT_LOSES_TO_LIVE,
        requestId: meta.requestId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          id: meta.id,
          model: meta.model,
          content: [
            {
              type: 'tool_use',
              id: monToolUseId,
              name: 'Monitor',
              input: { command: 'tail -f bot.log' }
            }
          ],
          usage: meta.usage
        },
        cwd
      },
      {
        type: 'user',
        timestamp: new Date().toISOString(),
        toolUseResult: { taskId: 'mon_e2e', timeoutMs: 0, persistent: true },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: monToolUseId,
              content: 'Monitor started (task mon_e2e).'
            }
          ]
        },
        cwd
      }
    ])
    fireHook('stop', {
      hook_event_name: 'Stop',
      background_tasks: [
        { id: 'mon_e2e', type: 'shell', status: 'running', description: 'tail -f bot.log' }
      ]
    })
    process.stdout.write('[fake-claude] bg-monitor parked\r\n> ')
    return
  }
  // CC§8
  if (text === '/bg-shell') {
    fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
    const shToolUseId = 'toolu_shell_e2e'
    const meta = usageMeta()
    append([
      { type: 'user', message: { role: 'user', content: text }, cwd },
      {
        type: 'assistant',
        version: TRANSCRIPT_VERSION_THAT_LOSES_TO_LIVE,
        requestId: meta.requestId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          id: meta.id,
          model: meta.model,
          content: [
            { type: 'tool_use', id: shToolUseId, name: 'Bash', input: { command: 'npm test' } }
          ],
          usage: meta.usage
        },
        cwd
      },
      {
        type: 'user',
        timestamp: new Date().toISOString(),
        toolUseResult: {
          stdout: '',
          stderr: '',
          interrupted: false,
          backgroundTaskId: 'bash_e2e',
          timedOutAfterMs: 120000
        },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: shToolUseId,
              content: 'Command timed out and was moved to the background (ID: bash_e2e).'
            }
          ]
        },
        cwd
      }
    ])
    fireHook('stop', { hook_event_name: 'Stop' })

    setTimeout(() => {
      const done = usageMeta()
      append([
        {
          type: 'attachment',
          timestamp: new Date().toISOString(),
          attachment: {
            type: 'queued_command',
            prompt: taskNotification(shToolUseId, 'completed', 'Background command completed'),
            commandMode: 'task-notification'
          },
          cwd
        },
        {
          type: 'assistant',
          version: TRANSCRIPT_VERSION_THAT_LOSES_TO_LIVE,
          requestId: done.requestId,
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            id: done.id,
            model: done.model,
            content: [{ type: 'text', text: 'The suite passed.' }],
            usage: done.usage
          },
          cwd
        }
      ])
      fireHook('stop', { hook_event_name: 'Stop' })
      process.stdout.write('[fake-claude] bg-shell finished\r\n> ')
    }, 5000)
    process.stdout.write('[fake-claude] bg-shell running\r\n> ')
    return
  }
  if (text.startsWith('/write ')) {
    const rel = text.slice('/write '.length).trim()
    if (!rel) return void process.stdout.write('> ')
    fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
    // CC§2
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const body = `# ${rel}\n\nWritten mid-turn by the fake claude session.\n`
    fs.writeFileSync(abs, body)
    const meta = usageMeta()
    append([
      { type: 'user', message: { role: 'user', content: text }, cwd },
      {
        type: 'assistant',
        version: TRANSCRIPT_VERSION_THAT_LOSES_TO_LIVE,
        requestId: meta.requestId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          id: meta.id,
          model: meta.model,
          content: [
            { type: 'text', text: `Writing ${rel}.` },
            { type: 'tool_use', name: 'Write', input: { file_path: rel, content: body } }
          ],
          usage: meta.usage
        },
        cwd
      }
    ])
    setTimeout(() => {
      fireHook('stop', { hook_event_name: 'Stop' })
      process.stdout.write(`[fake-claude] wrote ${rel}\r\n> `)
    }, MID_TURN_WRITE_HOLD_MS_OUTLASTING_500MS_JSONL_POLL)
    return
  }
  // CC§2
  if (text.startsWith('/scratch ')) {
    const name = text.slice('/scratch '.length).trim()
    if (!name) return void process.stdout.write('> ')
    const base = process.env.KOLOFT_SCRATCHPAD_BASE || `/tmp/claude-${process.getuid?.() ?? 0}`
    const dir = path.join(base, path.basename(projDir), sessionId, 'scratchpad')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), `koloft_e2e_scratch_body for ${name}\n`)
    process.stdout.write(`[fake-claude] scratched ${name}\r\n> `)
    return
  }
  if (text.startsWith('/open-later ')) {
    const target = text.slice('/open-later '.length).trim()
    if (!target) return void process.stdout.write('> ')
    const marker = path.join(home, 'go-open')
    const tick = setInterval(() => {
      if (!fs.existsSync(marker)) return
      clearInterval(tick)
      try {
        cp.execFileSync('open', [target], {
          cwd,
          stdio: 'ignore',
          env: openEnvRoutingPastShimToRecordingFakeOpen()
        })
      } catch {}
    }, 200)
    process.stdout.write(`[fake-claude] armed open ${target}\r\n> `)
    return
  }
  if (text.startsWith('/open ')) {
    const target = text.slice('/open '.length).trim()
    if (!target) return void process.stdout.write('> ')
    try {
      cp.execFileSync('open', [target], {
        cwd,
        stdio: 'ignore',
        env: openEnvRoutingPastShimToRecordingFakeOpen()
      })
      process.stdout.write(`[fake-claude] opened ${target}\r\n> `)
    } catch (e) {
      process.stdout.write(`[fake-claude] open failed ${target}: ${e.message}\r\n> `)
    }
    return
  }
  if (text.startsWith('/koloft ')) {
    const rest = text.slice('/koloft '.length).trim()
    cp.execFile('/bin/sh', ['-c', `koloft ${rest}`], { cwd, env: process.env }, (e, out, err) => {
      const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0
      const said = `${out}${err}`.replace(/\r?\n/g, '\r\n')
      process.stdout.write(`${said}[fake-claude] koloft exit=${code}\r\n> `)
    })
    return
  }
  if (text === '/busy') {
    fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
    append([{ type: 'user', message: { role: 'user', content: text }, cwd }])
    let ticks = 0
    const busy = setInterval(() => {
      ticks += 1
      process.stdout.write(`[fake-claude] busy ${ticks}\r\n`)
      if (ticks >= 120) {
        clearInterval(busy)
        const meta = usageMeta()
        append([
          {
            type: 'assistant',
            version: TRANSCRIPT_VERSION_THAT_LOSES_TO_LIVE,
            requestId: meta.requestId,
            timestamp: new Date().toISOString(),
            message: {
              role: 'assistant',
              id: meta.id,
              model: meta.model,
              content: [{ type: 'text', text: 'Busy turn finished.' }],
              usage: meta.usage
            },
            cwd
          }
        ])
        fireHook('stop', { hook_event_name: 'Stop' })
        process.stdout.write('[fake-claude] busy finished\r\n> ')
      }
    }, 250)
    return
  }
  if (text === '/need-approval') {
    fireHook('notify', {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash'
    })
    process.stdout.write('[fake-claude] awaiting approval\r\n> ')
    return
  }
  if (!text) return void process.stdout.write('> ')
  fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
  const meta = usageMeta()
  append([
    { type: 'user', message: { role: 'user', content: text }, cwd },
    {
      type: 'assistant',
      version: TRANSCRIPT_VERSION_THAT_LOSES_TO_LIVE,
      requestId: meta.requestId,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        id: meta.id,
        model: meta.model,
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: text } }],
        usage: meta.usage
      },
      cwd
    }
  ])
  fireHook('stop', { hook_event_name: 'Stop' })
  process.stdout.write(`[fake-claude] handled: ${text}\r\n> `)
}
// CC§1
rl.on('close', () => shutdown('other'))
process.on('SIGTERM', () => shutdown('other'))
process.on('SIGHUP', () => shutdown('other'))
process.on('SIGWINCH', () => {
  process.stdout.write(`[fake-claude] winch ${process.stdout.columns}x${process.stdout.rows}\r\n> `)
})
