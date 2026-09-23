import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-hooks-'))
  return { app: { getPath: () => base, isPackaged: false } }
})

import { setupHooks, writeTabHookSettings, hookSettings } from '../../src/main/hooks'
import { dq, REMOTE_HOOK_DIR, remoteMachineDir } from '../../src/main/remote/paths'

let hookScript: string
let regDir: string
let base: string

beforeAll(() => {
  ;({ hookScript, regDir } = setupHooks())
  base = path.dirname(path.dirname(hookScript))
  stubBin = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-hook-stub-'))
  const answeringClaudeStub = path.join(stubBin, 'claude')
  fs.writeFileSync(answeringClaudeStub, '#!/bin/sh\necho "0.0.7-stub (Claude Code)"\n', {
    mode: 0o755
  })
})
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))
beforeEach(() => {
  for (const f of fs.readdirSync(regDir)) fs.rmSync(path.join(regDir, f), { force: true })
})

let stubBin: string

function fire(
  tab: string,
  event: string,
  payload: unknown,
  extraEnv?: Record<string, string>
): void {
  const res = spawnSync(hookScript, [regDir, tab, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv, PATH: `${stubBin}:${process.env.PATH}` }
  })
  if (res.status !== 0) throw new Error(`hook exited ${res.status}: ${res.stderr}`)
}
const readReg = (name: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(regDir, name), 'utf8'))
const readStatusLog = (tab: string): Record<string, string>[] =>
  fs
    .readFileSync(path.join(regDir, `${tab}.status.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

describe('injected hook script', () => {
  it('SessionStart seds session_id / transcript_path / cwd / reason into <tab>.json', () => {
    fire('tabH', 'start', {
      session_id: 'sess-123',
      transcript_path: '/home/u/.claude/projects/enc/sess-123.jsonl',
      cwd: '/home/u/project',
      hook_event_name: 'SessionStart',
      source: 'startup'
    })
    const reg = readReg('tabH.json')
    expect(reg).toMatchObject({
      tabId: 'tabH',
      event: 'start',
      sessionId: 'sess-123',
      transcriptPath: '/home/u/.claude/projects/enc/sess-123.jsonl',
      cwd: '/home/u/project'
    })
  })

  it('captures the auth wrapper account from the inherited env (info-card metadata)', () => {
    fire('tabA', 'start', { session_id: 's1' }, { ANT_ACCOUNT: 'work-acct' })
    expect(readReg('tabA.json')).toMatchObject({ account: 'work-acct' })
  })

  it('strips quotes/backslashes from the account so it can never break the JSON', () => {
    fire('tabA2', 'start', { session_id: 's1' }, { ANT_ACCOUNT: 'a"b\\c' })
    expect(readReg('tabA2.json')).toMatchObject({ account: 'abc' })
  })

  it('strips RAW control chars from the account (env values never went through tr -d \\n)', () => {
    fire('tabA4', 'start', { session_id: 's1' }, { ANT_ACCOUNT: 'team\tprod\n' })
    expect(readReg('tabA4.json')).toMatchObject({ account: 'teamprod' })
  })

  it('SessionStart seds the source (a compact restart must be distinguishable)', () => {
    fire('tabS1', 'start', { session_id: 's1', source: 'compact' })
    expect(readReg('tabS1.json')).toMatchObject({ source: 'compact' })
  })

  it('emits an empty account when no wrapper exported one', () => {
    fire('tabA3', 'start', { session_id: 's1' }, { ANT_ACCOUNT: '' })
    expect(readReg('tabA3.json')).toMatchObject({ account: '' })
  })

  // CC§1
  it('renames the tmux session after the claude session, but only over ssh, reporting the name it had before', () => {
    const log = path.join(stubBin, 'tmux-log')
    fs.writeFileSync(
      path.join(stubBin, 'tmux'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in display-message) echo k-sess-old;; esac\n`,
      { mode: 0o755 }
    )
    fs.rmSync(log, { force: true })

    fire('tabT1', 'start', { session_id: 'sess-local' }, { TMUX: '/tmp/s,1,0', TMUX_PANE: '%0' })
    expect(fs.existsSync(log)).toBe(false)
    expect(readReg('tabT1.json')).toMatchObject({ tmux: '' })

    fire(
      'tabT2',
      'start',
      { session_id: 'sess-new' },
      {
        KOLOFT_TMUX_FOLLOW: '1',
        TMUX: '/tmp/s,1,0',
        TMUX_PANE: '%3'
      }
    )
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'display-message -p -t %3 #S',
      'rename-session -t %3 k-sess-new'
    ])
    expect(readReg('tabT2.json')).toMatchObject({ tmux: 'k-sess-old' })
    fire(
      'tabT2',
      'stop',
      { session_id: 'sess-new' },
      {
        KOLOFT_TMUX_FOLLOW: '1',
        TMUX: '/tmp/s,1,0',
        TMUX_PANE: '%3'
      }
    )
    expect(readStatusLog('tabT2')[0]).toMatchObject({ event: 'stop', tmux: 'k-sess-old' })
    fs.rmSync(path.join(stubBin, 'tmux'), { force: true })
  })

  // CC§1
  it('version tier 1: CLAUDE_CODE_EXECPATH versioned-dir basename wins (resume-safe)', () => {
    fire(
      'tabV',
      'start',
      { session_id: 's1' },
      {
        CLAUDE_CODE_EXECPATH: '/x/versions/3.2.1',
        AI_AGENT: 'claude-code_9-9-9_agent'
      }
    )
    expect(readReg('tabV.json')).toMatchObject({ ccVersion: '3.2.1' })
  })

  // CC§1
  it('version tier 2: a non-version EXECPATH falls through to the AI_AGENT stamp', () => {
    fire(
      'tabV2',
      'start',
      { session_id: 's1' },
      {
        CLAUDE_CODE_EXECPATH: '/usr/local/lib/node_modules/@anthropic-ai/claude-code',
        AI_AGENT: 'claude-code_9-8-7_agent'
      }
    )
    expect(readReg('tabV2.json')).toMatchObject({ ccVersion: '9.8.7' })
  })

  it('with no env signal, the version stays empty — nothing slow runs before the write', () => {
    fire('tabV3', 'start', { session_id: 's1' }, { CLAUDE_CODE_EXECPATH: '', AI_AGENT: '' })
    expect(readReg('tabV3.json')).toMatchObject({ sessionId: 's1', ccVersion: '' })
  })

  it('SessionEnd carries the exit reason (drives the revert-to-terminal decision)', () => {
    fire('tabH', 'end', { session_id: 'sess-123', reason: 'prompt_input_exit' })
    expect(readReg('tabH.json')).toMatchObject({ event: 'end', reason: 'prompt_input_exit' })
  })

  it('Stop writes a run-state report to <tab>.status.jsonl', () => {
    fire('tabH', 'stop', { hook_event_name: 'Stop' })
    expect(readStatusLog('tabH')).toEqual([
      { tabId: 'tabH', event: 'stop', message: '', sessionId: '', tmux: '' }
    ])
  })

  // CC§5
  it.each(['prompt', 'stop', 'notify'])(
    'a %s report names the session it belongs to, so a /fork copy sharing the log is told apart',
    (event) => {
      fire('tabS', event, { session_id: 'sess-abc', message: 'x' })
      expect(readStatusLog('tabS')[0]).toMatchObject({
        tabId: 'tabS',
        event,
        sessionId: 'sess-abc'
      })
    }
  )

  // CC§8
  it('takes the TOP-LEVEL session_id, never one nested in a later field', () => {
    fire('tabN', 'stop', {
      session_id: 'sess-top',
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'a1', status: 'running', session_id: 'sess-nested' }]
    })
    expect(readStatusLog('tabN')[0].sessionId).toBe('sess-top')
  })

  it('binding takes the top-level session_id too', () => {
    fire('tabN2', 'start', {
      session_id: 'sess-top',
      transcript_path: '/t.jsonl',
      hook_event_name: 'SessionStart',
      source: 'startup',
      nested: { session_id: 'sess-nested' }
    })
    expect(readReg('tabN2.json').sessionId).toBe('sess-top')
  })

  it('binding and run-state parse the SAME id out of one payload', () => {
    const payload = {
      session_id: 'sess-top',
      transcript_path: '/t.jsonl',
      source: 'startup',
      background_tasks: [{ session_id: 'sess-nested' }]
    }
    fire('tabP', 'start', payload)
    fire('tabP', 'stop', payload)
    expect(readStatusLog('tabP')[0].sessionId).toBe(readReg('tabP.json').sessionId)
  })

  // CC§5
  it("a fork's SessionStart does not clobber the tab's binding snapshot, which is never re-delivered", () => {
    fire('tabFK', 'start', {
      session_id: 'sess-parent',
      transcript_path: '/p.jsonl',
      hook_event_name: 'SessionStart',
      source: 'startup'
    })
    fire('tabFK', 'start', {
      session_id: 'sess-fork',
      transcript_path: '/f.jsonl',
      hook_event_name: 'SessionStart',
      source: 'fork'
    })
    expect(readReg('tabFK.json').sessionId).toBe('sess-parent')
  })

  it('scrubs characters that would break the JSON line, as the message field does', () => {
    fire('tabQ', 'stop', { session_id: 'sess\\bad', hook_event_name: 'Stop' })
    expect(readStatusLog('tabQ')[0].sessionId).toBe('sessbad')
  })

  // CC§8
  it("a turn-end carries the COUNT of Claude Code's own live background tasks", () => {
    fire('tabBG', 'stop', {
      background_tasks: [
        { id: 'a1', type: 'subagent', status: 'running', description: 'reviewer' },
        { id: 'b2', type: 'shell', status: 'running', command: 'ls [a-z]* | wc -l' }
      ],
      last_assistant_message: 'kicked it off'
    })
    const rec = readStatusLog('tabBG')[0] as unknown as { event: string; bgl: string }
    expect(rec.event).toBe('stop')
    expect(rec.bgl).toBe('a1:subagent,b2:shell')
  })

  // CC§8
  it('a turn-end with an empty list is distinguishable from one with no list at all', () => {
    fire('tabE1', 'stop', { background_tasks: [], last_assistant_message: 'done' })
    fire('tabE2', 'stop', { last_assistant_message: 'done' })
    const empty = readStatusLog('tabE1')[0] as unknown as { bgl?: string }
    const absent = readStatusLog('tabE2')[0] as unknown as { bgl?: string }
    expect(empty.bgl).toBe('')
    expect(absent.bgl).toBeUndefined()
  })

  // CC§8
  it('only the task list is read — a later field such as session_crons cannot add to it', () => {
    fire('tabBG2', 'stop', {
      background_tasks: [],
      session_crons: [{ id: 'c1', status: 'running' }],
      last_assistant_message: 'the shell printed "status":"running" in its output'
    })
    expect((readStatusLog('tabBG2')[0] as unknown as { bgl: string }).bgl).toBe('')
  })

  // CC§8
  it('a turn-end says whether claude has a wakeup scheduled, so a /loop between ticks is not idle', () => {
    fire('tabWK1', 'stop', {
      background_tasks: [],
      session_crons: [{ id: '8044b6e3', schedule: '4 15 * * *', recurring: false }]
    })
    fire('tabWK2', 'stop', { background_tasks: [], session_crons: [] })
    fire('tabWK3', 'stop', { background_tasks: [] })
    const wake = (tab: string): unknown =>
      (readStatusLog(tab)[0] as unknown as { wake?: number }).wake
    expect(wake('tabWK1')).toBe(1)
    expect(wake('tabWK2')).toBe(0)
    expect(wake('tabWK3')).toBeUndefined()
  })

  it('a task command carrying JSON punctuation cannot truncate the scan', () => {
    fire('tabBG3', 'stop', {
      background_tasks: [
        { id: 'b1', type: 'shell', status: 'running', command: 'echo "}]" | jq -r ".[0]"' },
        { id: 'a1', type: 'subagent', status: 'running', description: 'still live' }
      ],
      session_crons: []
    })
    const rec = readStatusLog('tabBG3')[0] as unknown as { bgl: string }
    expect(rec.bgl).toBe('b1:shell,a1:subagent')
  })

  // CC§8
  it('live means NOT-terminal, not the single literal "running"', () => {
    fire('tabBG4', 'stop', {
      background_tasks: [
        { id: 'a1', type: 'subagent', status: 'running' },
        { id: 'a2', type: 'subagent', status: 'pending' },
        { id: 'a3', type: 'subagent', status: 'completed' },
        { id: 'a4', type: 'shell', status: 'killed' }
      ]
    })
    const rec = readStatusLog('tabBG4')[0] as unknown as { bgl: string }
    expect(rec.bgl).toBe('a1:subagent,a2:subagent')
  })

  // CC§8
  it('the list is id:type of each live task, scrubbed to a safe alphabet', () => {
    fire('tabBL', 'stop', {
      background_tasks: [
        {
          id: 'b0167powo',
          type: 'shell',
          status: 'running',
          description: 'sleep 25',
          command: 'sleep 25 # "status":"completed" {"id":"fake","type":"subagent"}'
        },
        { id: 't6fdjbjat', type: 'teammate', status: 'running', description: '{"id":"x"}' },
        { id: 'm1', type: 'MCP task', status: 'pending' },
        { id: 'c1', type: 'cloud session', status: 'running' },
        { id: 'a9', type: 'subagent', status: 'completed' },
        { id: 'we ird-id', type: 'auto-mode scan', status: 'running' }
      ]
    })
    const rec = readStatusLog('tabBL')[0] as unknown as { bgl: string }
    expect(rec.bgl).toBe(
      'b0167powo:shell,t6fdjbjat:teammate,m1:mcp-task,c1:cloud-session,weird-id:auto-mode-scan'
    )
  })

  it('a payload-less hook invocation still writes a parseable record', () => {
    const res = spawnSync(hookScript, [regDir, 'tabNP', 'stop'], { input: '', encoding: 'utf8' })
    expect(res.status).toBe(0)
    const rec = readStatusLog('tabNP')[0] as unknown as { event: string; bgl?: string }
    expect(rec.event).toBe('stop')
    expect(rec.bgl).toBeUndefined()
  })

  it('Notification preserves the permission message (approval vs idle discrimination)', () => {
    fire('tabH', 'notify', { message: 'Claude needs your permission to use Bash' })
    expect(readStatusLog('tabH')[0].message).toContain('permission')
  })

  it('run-state reports APPEND — a whole turn survives, not just its last edge', () => {
    fire('tabT', 'prompt', { hook_event_name: 'UserPromptSubmit' })
    fire('tabT', 'stop', { hook_event_name: 'Stop' })
    expect(readStatusLog('tabT').map((r) => r.event)).toEqual(['prompt', 'stop'])
  })

  it('a new tab starts with no run-state log and no registration snapshot (pids, hence tab ids, recycle)', () => {
    fire('pty-abc-1', 'stop', { hook_event_name: 'Stop' })
    expect(readStatusLog('pty-abc-1')).toHaveLength(1)
    fs.writeFileSync(
      path.join(regDir, 'pty-abc-1.json'),
      JSON.stringify({ tabId: 'pty-abc-1', event: 'end', reason: 'prompt_input_exit' })
    )
    writeTabHookSettings(setupHooks(), 'pty-abc-1')
    expect(fs.existsSync(path.join(regDir, 'pty-abc-1.status.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(regDir, 'pty-abc-1.json'))).toBe(false)
  })

  it('every appended report is one whole line (concurrent hooks cannot interleave)', () => {
    for (let i = 0; i < 6; i++) fire('tabL', i % 2 ? 'stop' : 'prompt', {})
    const raw = fs.readFileSync(path.join(regDir, 'tabL.status.jsonl'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.trim().split('\n')).toHaveLength(6)
  })

  // PLATFORM§36
  describe('posttool: statusline git-review cache invalidation', () => {
    let home: string
    let cacheDir: string
    const entry = (name: string): string => path.join(cacheDir, name)
    const mtime = (p: string): number => fs.statSync(p).mtimeMs

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-posttool-home-'))
      cacheDir = path.join(home, '.cache', 'ccstatusline', 'git-review')
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(entry('git-review-aaaa.json'), '{"version":1,"data":null}')
      fs.writeFileSync(entry('git-review-bbbb.json'), '{"version":1,"data":null}')
      fs.writeFileSync(entry('git-review-aaaa.json.lock'), '')
    })

    const firePosttool = (command: string): void =>
      fire(
        'tabPT',
        'posttool',
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          cwd: '/home/u/project'
        },
        { HOME: home }
      )

    it('a gh pr command marks every cached entry stale (older than the 30s TTL)', () => {
      firePosttool('gh pr create --fill')
      const staleBefore = Date.now() - 30_000
      expect(mtime(entry('git-review-aaaa.json'))).toBeLessThan(staleBefore)
      expect(mtime(entry('git-review-bbbb.json'))).toBeLessThan(staleBefore)
    })

    it('recognizes state-changing subcommands anywhere in a compound command', () => {
      firePosttool('cd /repo && gh pr merge 89 --squash --delete-branch')
      expect(mtime(entry('git-review-aaaa.json'))).toBeLessThan(Date.now() - 30_000)
    })

    it('never freshens refresh locks — a young lock would SUPPRESS the re-query', () => {
      const before = mtime(entry('git-review-aaaa.json.lock'))
      firePosttool('gh pr close 42')
      expect(mtime(entry('git-review-aaaa.json.lock'))).toBe(before)
    })

    it('an unrelated command leaves the cache alone (no gh query storm)', () => {
      const before = mtime(entry('git-review-aaaa.json'))
      firePosttool('git status && ls -la')
      expect(mtime(entry('git-review-aaaa.json'))).toBe(before)
    })

    it('exits 0 when no cache dir exists yet (fresh machine, statusline never rendered)', () => {
      fs.rmSync(cacheDir, { recursive: true, force: true })
      firePosttool('gh pr create --fill')
    })

    it('writes nothing to the reg dir — PostToolUse fires per tool call, reg must not flood', () => {
      firePosttool('gh pr create --fill')
      expect(fs.readdirSync(regDir)).toEqual([])
    })
  })

  it('injects a Bash-matched PostToolUse hook only when the statusline rides along', () => {
    const sl = { type: 'command' as const, command: "'/x/statusline/run.sh'", padding: 0 }
    const withSl = JSON.parse(
      fs.readFileSync(writeTabHookSettings(setupHooks(), 'tabPT1', sl), 'utf8')
    )
    expect(withSl.hooks.PostToolUse).toHaveLength(1)
    expect(withSl.hooks.PostToolUse[0].matcher).toBe('Bash')
    expect(withSl.hooks.PostToolUse[0].hooks[0].command).toContain(' posttool')
    const without = JSON.parse(
      fs.readFileSync(writeTabHookSettings(setupHooks(), 'tabPT2'), 'utf8')
    )
    expect(without.hooks).not.toHaveProperty('PostToolUse')
  })

  // CC§8
  // CC§8
  it('a Notification reaches Koloft only when claude stops to wait on the person, never for a mid-turn one', () => {
    const settings = JSON.parse(
      fs.readFileSync(writeTabHookSettings(setupHooks(), 'tabNT'), 'utf8')
    )
    const types: string[] = settings.hooks.Notification[0].matcher.split('|')
    expect(types).toEqual(expect.arrayContaining(['permission_prompt', 'idle_prompt']))
    for (const midTurn of ['agent_completed', 'push_notification', 'auth_success']) {
      expect(types).not.toContain(midTurn)
    }
  })

  it('carries a statusLine next to the hooks when the built-in statusline is on', () => {
    const sl = { type: 'command' as const, command: "'/x/statusline/run.sh'", padding: 0 }
    const file = writeTabHookSettings(setupHooks(), 'tabSL', sl)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(settings.statusLine).toEqual(sl)
    expect(settings.hooks.SessionStart).toBeTruthy()
  })

  it('omits statusLine when the toggle is off — the user’s own settings stay in charge', () => {
    const file = writeTabHookSettings(setupHooks(), 'tabSL2')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).not.toHaveProperty('statusLine')
  })

  describe('U-HOOK-2: settings for a tab running on another machine', () => {
    const machine = remoteMachineDir('m-abc123')
    const build = (): Record<string, unknown> =>
      hookSettings(
        `${machine}/hook.sh`,
        REMOTE_HOOK_DIR,
        'tabR',
        {
          type: 'command',
          command: dq(`${machine}/run.sh`),
          padding: 0
        },
        dq
      )

    const commands = (s: Record<string, unknown>): string[] =>
      Object.values(s.hooks as Record<string, { hooks: { command: string }[] }[]>).flatMap((g) =>
        g.flatMap((e) => e.hooks.map((h) => h.command))
      )

    it('every hook command names the machine’s own paths, double-quoted so $HOME expands', () => {
      const cmds = commands(build())
      expect(cmds).toContain(
        `"$HOME/.koloft/m-abc123/hook.sh" "$HOME/.koloft/hook-sessions" "tabR" start`
      )
      for (const c of cmds) expect(c).not.toContain("'$HOME")
    })

    it('points the statusline at the machine’s copy of the wrapper', () => {
      const sl = build().statusLine as { command: string }
      expect(sl.command).toBe('"$HOME/.koloft/m-abc123/run.sh"')
    })

    it('writes nothing here — a same-named local tab keeps its status log', () => {
      const log = path.join(regDir, 'tabR.status.jsonl')
      fs.writeFileSync(log, '{"a":1}\n{"a":2}\n')
      build()
      expect(fs.readFileSync(log, 'utf8')).toBe('{"a":1}\n{"a":2}\n')
    })
  })
})

describe('setupHooks at startup', () => {
  it('prunes only reports and settings older than 12 hours — a fresh one, such as another Koloft instance’s in the same folder, survives', () => {
    const { settingsDir } = setupHooks()
    const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000)
    const fresh = [
      path.join(regDir, 'peer-1.json'),
      path.join(regDir, 'peer-1.status.jsonl'),
      path.join(settingsDir, 'peer-1.json')
    ]
    const old = [
      path.join(regDir, 'dead-1.json'),
      path.join(regDir, 'dead-1.status.jsonl'),
      path.join(settingsDir, 'dead-1.json')
    ]
    for (const f of [...fresh, ...old]) fs.writeFileSync(f, '{}\n')
    for (const f of fresh) fs.utimesSync(f, hoursAgo(11), hoursAgo(11))
    for (const f of old) fs.utimesSync(f, hoursAgo(13), hoursAgo(13))

    setupHooks()

    for (const f of fresh) expect(fs.existsSync(f), f).toBe(true)
    for (const f of old) expect(fs.existsSync(f), f).toBe(false)
  })
})
