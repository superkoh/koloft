import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

// setupHooks() calls app.getPath('userData'); stub Electron so it writes the real hook
// script to disk. We then exec that script exactly as Claude Code would (regDir + tabId
// baked in as args, event payload on stdin) and assert the JSON it seds out — the
// authoritative tab↔session binding + run-state reports the tracker consumes.
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
  base = path.dirname(path.dirname(hookScript)) // hookScript is <base>/hooks/sessionstart.sh
  stubBin = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-hook-stub-'))
  const stub = path.join(stubBin, 'claude')
  fs.writeFileSync(stub, '#!/bin/sh\necho "0.0.7-stub (Claude Code)"\n', { mode: 0o755 })
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
    // a stub `claude` first on PATH that would answer, so an empty version proves no probe
    env: { ...process.env, ...extraEnv, PATH: `${stubBin}:${process.env.PATH}` }
  })
  if (res.status !== 0) throw new Error(`hook exited ${res.status}: ${res.stderr}`)
}
const readReg = (name: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(regDir, name), 'utf8'))
/** the tab's run-state log, one parsed record per appended transition */
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
    // an auth wrapper capturing the tag via command substitution can leave a trailing
    // newline / embedded tab — raw bytes, unlike the JSON-escaped stdin payload. An
    // unstripped control char makes the whole registration unparseable, silently
    // killing the authoritative hook binding (readReg would throw right here).
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

  // A remote session runs inside tmux, and the tmux session is named after the claude
  // session in it. Only the hook is in a position to keep that true across an in-TUI
  // /clear, which mints a new id while the same claude keeps running.
  it('renames the tmux session after the claude session, but only over ssh', () => {
    const log = path.join(stubBin, 'tmux-log')
    // the stub answers `display-message … '#S'` with the session's CURRENT name
    fs.writeFileSync(
      path.join(stubBin, 'tmux'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in display-message) echo k-sess-old;; esac\n`,
      { mode: 0o755 }
    )
    fs.rmSync(log, { force: true })

    // a local claude: nothing to rename, no tmux to ask, and no name in the report
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
    // the name is read BEFORE the rename: after a /clear, Koloft still knows the old one
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

  it('version tier 1: CLAUDE_CODE_EXECPATH versioned-dir basename wins (resume-safe)', () => {
    fire(
      'tabV',
      'start',
      { session_id: 's1' },
      {
        CLAUDE_CODE_EXECPATH: '/x/versions/3.2.1',
        AI_AGENT: 'claude-code_9-9-9_agent' // present but must not be consulted
      }
    )
    expect(readReg('tabV.json')).toMatchObject({ ccVersion: '3.2.1' })
  })

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

  // A `/fork`ed background copy inherits this tab's --settings, so ITS turns append to
  // THIS tab's run-state log under THIS tab's id. Without the session id on the line
  // there is nothing to tell the two apart, and the copy drives the tab's status dot
  // and its turn-done notifications (docs/claude-code-contract.md §5; the fork design doc is retired).
  it.each(['prompt', 'stop', 'notify'])('a %s report names the session it belongs to', (event) => {
    fire('tabS', event, { session_id: 'sess-abc', message: 'x' })
    expect(readStatusLog('tabS')[0]).toMatchObject({
      tabId: 'tabS',
      event,
      sessionId: 'sess-abc'
    })
  })

  // The id decides whether the reader keeps or drops the line, so mis-parsing it is not
  // cosmetic: a foreign id silently discards a real turn transition (dot pinned
  // 'working', no turn-done). A Stop payload already carries nested objects — the
  // background_tasks list — and any of them may grow its own session_id.
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

  // The gate compares an id parsed for the BINDING against one parsed for a RUN-STATE
  // line. Two extractions that can drift would make the comparison meaningless — the
  // binding would keep working while every transition is dropped as "not mine".
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

  // $tab.json is a last-writer-wins snapshot with NO re-delivery (unlike the run-state
  // log, which is append-only and has a poll backstop). If a fork's start lands on top
  // of a parent report Koloft has not read yet, that binding update is gone for good — and
  // with the id gate in place the tab then rejects every later report of its own live
  // session. The copy's start is something Koloft discards anyway, so never write it.
  it("a fork's SessionStart does not clobber the tab's binding snapshot", () => {
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
    // `[^"]*` happily captures backslashes; one at the wrong place makes the emitted
    // line unparseable and drainStatusLog skips it with no log at all.
    fire('tabQ', 'stop', { session_id: 'sess\\bad', hook_event_name: 'Stop' })
    expect(readStatusLog('tabQ')[0].sessionId).toBe('sessbad')
  })

  it("a turn-end carries the COUNT of Claude Code's own live background tasks", () => {
    // The Stop payload enumerates what is STILL RUNNING at the moment the turn
    // ends (verified on real claude 2.1.228) — the authoritative answer to the
    // question Koloft used to reconstruct from spawn acks. Only the count is
    // recorded, not the list: a task's `command` can be multi-KB and quote-laden,
    // and a long line would break the one-atomic-append-per-transition property
    // the run-state log depends on.
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

  it('a turn-end with an empty list is distinguishable from one with no list at all', () => {
    // zero live tasks -> rest the dot; no list at all (older claude) -> the caller
    // must fall back to the ledger, so these two must never collapse together
    fire('tabE1', 'stop', { background_tasks: [], last_assistant_message: 'done' })
    fire('tabE2', 'stop', { last_assistant_message: 'done' })
    const empty = readStatusLog('tabE1')[0] as unknown as { bgl?: string }
    const absent = readStatusLog('tabE2')[0] as unknown as { bgl?: string }
    expect(empty.bgl).toBe('')
    expect(absent.bgl).toBeUndefined()
  })

  it('only the task list is read — a later field cannot add to it', () => {
    // A phantom entry is NOT harmless: a reported task holds the deferral, so it
    // pins the dot at 'working' with no turn-done — and the next turn-end reports
    // the same phantom, for the session's whole life. `session_crons` is the
    // concrete case: a running cron sits AFTER the task array in the same payload.
    fire('tabBG2', 'stop', {
      background_tasks: [],
      session_crons: [{ id: 'c1', status: 'running' }],
      last_assistant_message: 'the shell printed "status":"running" in its output'
    })
    expect((readStatusLog('tabBG2')[0] as unknown as { bgl: string }).bgl).toBe('')
  })

  it('a task command carrying JSON punctuation cannot truncate the scan', () => {
    // the array cannot be bounded by "the first ]" — a command may legally
    // contain ] and }, and cutting there would silently drop every task after it
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

  it('live means NOT-terminal, not the single literal "running"', () => {
    // A reported empty list is authoritative: it clears the inferred ledger and
    // fires a turn-done. So an unknown non-terminal status (pending/queued/starting)
    // must read as live — whitelisting one literal would turn a live task into a
    // false turn-done, the exact failure this channel exists to prevent.
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

  it('the list is id:type of each live task, scrubbed to a safe alphabet', () => {
    // Koloft judges each task by what it is (a parked teammate, a dev server, a
    // running subagent), so the type rides along. Ids are 9 base36 chars and
    // types a fixed vocabulary, so both are scrubbed rather than
    // escaped: nothing here may ever carry JSON punctuation into the log line.
    // A description quoting another task's fields sits AFTER the real ones and
    // arrives escaped, so it cannot fake an id or a type.
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
    // an empty/garbled stdin must never cost the turn-end itself: the record has
    // to stay valid JSON, just without a list (so the caller falls back)
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
    // The prompt→stop pair of one turn can land microseconds apart. Overwriting a
    // single report file would leave only 'stop' for the reader to find, so Koloft
    // would never see the turn run (no 'working' dot) and never raise its turn-done.
    fire('tabT', 'prompt', { hook_event_name: 'UserPromptSubmit' })
    fire('tabT', 'stop', { hook_event_name: 'Stop' })
    expect(readStatusLog('tabT').map((r) => r.event)).toEqual(['prompt', 'stop'])
  })

  it('a new tab starts with an empty run-state log (pids, hence tab ids, recycle)', () => {
    fire('pty-abc-1', 'stop', { hook_event_name: 'Stop' })
    expect(readStatusLog('pty-abc-1')).toHaveLength(1)
    // …and no registration snapshot either: the pty-exit drain reads <tab>.json
    // straight off disk, so a dead run's SessionEnd left in place could replay as
    // THIS tab's graceful exit and evict a session the user never closed
    fs.writeFileSync(
      path.join(regDir, 'pty-abc-1.json'),
      JSON.stringify({ tabId: 'pty-abc-1', event: 'end', reason: 'prompt_input_exit' })
    )
    // a later Koloft run mints the same tab id: setting that tab up must clear the
    // dead tab's log, which is read from byte 0 and would otherwise replay
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

  describe('posttool: statusline git-review cache invalidation', () => {
    // Contract under test: after a PR-state-changing gh command, every cached
    // git-review entry must read as STALE to ccstatusline — whose staleness rule
    // is `now - mtime > 30_000` — so the very next render re-queries instead of
    // waiting out the TTL. Lock files must NOT be freshened: a .lock younger
    // than 30s suppresses refreshes, the exact opposite of the intent.
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
      firePosttool('gh pr create --fill') // fire() throws on non-zero exit
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
    // statusline off → its cache is not ours to manage; the hook must not ride
    const without = JSON.parse(
      fs.readFileSync(writeTabHookSettings(setupHooks(), 'tabPT2'), 'utf8')
    )
    expect(without.hooks).not.toHaveProperty('PostToolUse')
  })

  it('carries a statusLine next to the hooks when the built-in statusline is on', () => {
    const sl = { type: 'command' as const, command: "'/x/statusline/run.sh'", padding: 0 }
    const file = writeTabHookSettings(setupHooks(), 'tabSL', sl)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(settings.statusLine).toEqual(sl)
    expect(settings.hooks.SessionStart).toBeTruthy() // rides along, never replaces
  })

  it('omits statusLine when the toggle is off — the user’s own settings stay in charge', () => {
    const file = writeTabHookSettings(setupHooks(), 'tabSL2')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).not.toHaveProperty('statusLine')
  })

  // U-HOOK-2. A remote tab's settings describe the OTHER machine: the paths are spelt
  // with `$HOME` and must reach that machine's shell inside double quotes, and building
  // them must not touch this machine's registration dir — a same-named local tab keeps
  // its own status log.
  describe('settings for a tab running on another machine', () => {
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
