import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn, spawnSync } from 'child_process'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-hooks-'))
  return { app: { getPath: () => base, isPackaged: false } }
})

import {
  setupHooks,
  writeTabHookSettings,
  hookSettings,
  writeConductorMarker,
  removeConductorMarker,
  markAnswerable,
  REPLY_LANGUAGE_REMINDER
} from '../../src/main/hooks'
import { dq, REMOTE_HOOK_DIR, remoteMachineDir } from '../../src/main/remote/paths'

let hookScript: string
let regDir: string
let base: string
const noPeerInstance = (): boolean => false

beforeAll(() => {
  ;({ hookScript, regDir } = setupHooks(noPeerInstance))
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
): string {
  const res = spawnSync(hookScript, [regDir, tab, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv, PATH: `${stubBin}:${process.env.PATH}` }
  })
  if (res.status !== 0) throw new Error(`hook exited ${res.status}: ${res.stderr}`)
  return res.stdout
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

  // CC§1
  it('a compaction starts and ends in the status log, in order, since the start drop is deduped on a mirror', () => {
    fire('tabK', 'compacting', { session_id: 's1', trigger: 'manual' })
    fire('tabK', 'start', { session_id: 's1', source: 'compact' })
    fire('tabK', 'start', { session_id: 's2', source: 'clear' })
    fire('tabK', 'compacting', { session_id: 's2', trigger: 'manual' })
    fire('tabK', 'start', { session_id: 's2', source: 'compact' })
    expect(readStatusLog('tabK').map((r) => [r.event, r.sessionId])).toEqual([
      ['compacting', 's1'],
      ['compacted', 's1'],
      ['compacting', 's2'],
      ['compacted', 's2']
    ])
  })

  it('every session gets the PreCompact hook', () => {
    const settings = hookSettings('/x/hook.sh', '/x/reg', 'tabPC') as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    expect(settings.hooks.PreCompact[0].hooks[0].command).toMatch(/ compacting$/)
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

  // CC§17
  it('every prompt hands Claude the reply-language reminder; Stop and Notification print nothing', () => {
    const out = fire('tabLang', 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: '你好' })
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: REPLY_LANGUAGE_REMINDER
      }
    })
    expect(fire('tabLang', 'stop', { hook_event_name: 'Stop' })).toBe('')
    expect(fire('tabLang', 'notify', { message: 'Claude is waiting for your input' })).toBe('')
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
    writeTabHookSettings(setupHooks(noPeerInstance), 'pty-abc-1')
    expect(fs.existsSync(path.join(regDir, 'pty-abc-1.status.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(regDir, 'pty-abc-1.json'))).toBe(false)
  })

  describe('conductor role', () => {
    const startOutput = (tab: string, source: string): string =>
      spawnSync(hookScript, [regDir, tab, 'start'], {
        input: JSON.stringify({ session_id: 's1', source }),
        encoding: 'utf8'
      }).stdout

    it("a conductor tab's SessionStart hands claude its role as additional context, again after /clear", () => {
      writeConductorMarker(regDir, 'tabC', 'You are the conductor.')
      for (const source of ['startup', 'clear']) {
        expect(JSON.parse(startOutput('tabC', source))).toEqual({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: 'You are the conductor.'
          }
        })
      }
    })

    it('a plain tab, or a conductor tab whose marker is gone, prints nothing', () => {
      expect(startOutput('tabP', 'startup')).toBe('')
      writeConductorMarker(regDir, 'tabC', 'You are the conductor.')
      removeConductorMarker(regDir, 'tabC')
      expect(startOutput('tabC', 'startup')).toBe('')
    })

    type Hooks = Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    const hooksOf = (conductor: boolean): Hooks =>
      JSON.parse(
        fs.readFileSync(
          writeTabHookSettings(setupHooks(noPeerInstance), 'tabG', undefined, true, conductor),
          'utf8'
        )
      ).hooks

    it('only a conductor tab gets the gate, a PreToolUse hook on every tool', () => {
      expect(hooksOf(false)).not.toHaveProperty('PreToolUse')
      expect(hooksOf(true).PreToolUse).toEqual([
        { matcher: '*', hooks: [{ type: 'command', command: expect.any(String) }] }
      ])
    })

    // ADR-0029 CC§15
    describe('the gate lets a conductor read, write its own memory folder, ask the owner and run one plain koloft command, and nothing else', () => {
      let command: string
      beforeAll(() => {
        command = hooksOf(true).PreToolUse[0].hooks[0].command
      })
      const gate = (event: unknown): 'allow' | 'deny' => {
        const res = spawnSync('/bin/sh', ['-c', command], {
          input: typeof event === 'string' ? event : JSON.stringify(event),
          encoding: 'utf8'
        })
        if (res.status !== 0) throw new Error(`gate exited ${res.status}: ${res.stderr}`)
        if (res.stdout === '') return 'allow'
        expect(JSON.parse(res.stdout).hookSpecificOutput).toMatchObject({
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny'
        })
        return 'deny'
      }
      const bash = (command: string): unknown => ({ tool_name: 'Bash', tool_input: { command } })
      const transcript_path = '/home/o/.claude/projects/-conductors-global/c1.jsonl'
      const write = (tool_name: string, file_path: string): unknown => ({
        tool_name,
        transcript_path,
        tool_input: { file_path, content: 'x' }
      })

      it.each([
        ['Read', { tool_name: 'Read', tool_input: { file_path: '/ws/a/README.md' } }],
        ['Grep', { tool_name: 'Grep', tool_input: { pattern: 'x' } }],
        ['a question to the owner', { tool_name: 'AskUserQuestion', tool_input: {} }],
        ['koloft help', bash('koloft help')],
        ['a koloft command with spaces around it', bash('  koloft session list \n')],
        ['operators inside quotes', bash('koloft session send a -- "fix x; then y && z | w"')],
        ['a multi-line single-quoted message', bash("koloft session send a -- 'one\ntwo $HOME'")],
        ['an escaped quote', bash('koloft session send a -- "say \\"hi\\" now"')],
        [
          'a Write into its own memory folder',
          write('Write', '/home/o/.claude/projects/-conductors-global/memory/MEMORY.md')
        ],
        [
          'an Edit in its own memory folder',
          write('Edit', '/home/o/.claude/projects/-conductors-global/memory/a/b.md')
        ]
      ])('allows %s', (_name, event) => {
        expect(gate(event)).toBe('allow')
      })

      it.each([
        ['Write', { tool_name: 'Write', tool_input: { file_path: '/ws/a/x', content: 'x' } }],
        ['Edit', { tool_name: 'Edit', tool_input: { file_path: '/ws/a/x' } }],
        ['a subagent', { tool_name: 'Agent', tool_input: { prompt: 'fix it' } }],
        ['WebFetch', { tool_name: 'WebFetch', tool_input: { url: 'https://x' } }],
        ['a command that is not koloft', bash('echo x > /ws/a/x')],
        ['a name that only starts with koloft', bash('koloftx help')],
        ['a chained command', bash('koloft help && rm -rf /ws/a')],
        ['a second command after ;', bash('koloft help; ls')],
        ['a second command on a new line', bash('koloft help\nrm -rf /ws/a')],
        ['a pipe', bash('koloft help | sh')],
        ['a redirect', bash('koloft session read a > /ws/a/out')],
        ['command substitution in double quotes', bash('koloft session send a -- "$(rm x)"')],
        ['backticks', bash('koloft session send a -- `rm x`')],
        ['an unclosed quote', bash("koloft session send a -- 'oops")],
        ['input that is not JSON', 'not json'],
        [
          'a Write beside its memory folder, onto its transcript',
          write('Write', '/home/o/.claude/projects/-conductors-global/c1.jsonl')
        ],
        [
          'a Write that climbs out of its memory folder',
          write('Write', '/home/o/.claude/projects/-conductors-global/memory/../../x/memory/a.md')
        ],
        [
          'a folder whose name only starts like its memory folder',
          write('Write', '/home/o/.claude/projects/-conductors-global/memory-x/a.md')
        ],
        [
          'another session’s memory folder',
          write('Edit', '/home/o/.claude/projects/-ws-a/memory/a.md')
        ]
      ])('denies %s', (_name, event) => {
        expect(gate(event)).toBe('deny')
      })
    })
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

    const firePosttool = (command: string): string =>
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
      fs.readFileSync(writeTabHookSettings(setupHooks(noPeerInstance), 'tabPT1', sl), 'utf8')
    )
    expect(withSl.hooks.PostToolUse).toHaveLength(1)
    expect(withSl.hooks.PostToolUse[0].matcher).toBe('Bash')
    expect(withSl.hooks.PostToolUse[0].hooks[0].command).toContain(' posttool')
    const without = JSON.parse(
      fs.readFileSync(writeTabHookSettings(setupHooks(noPeerInstance), 'tabPT2'), 'utf8')
    )
    expect(without.hooks).not.toHaveProperty('PostToolUse')
  })

  // CC§8
  // CC§8
  it('a Notification reaches Koloft only when claude stops to wait on the person, never for a mid-turn one', () => {
    const settings = JSON.parse(
      fs.readFileSync(writeTabHookSettings(setupHooks(noPeerInstance), 'tabNT'), 'utf8')
    )
    const types: string[] = settings.hooks.Notification[0].matcher.split('|')
    expect(types).toEqual(expect.arrayContaining(['permission_prompt', 'idle_prompt']))
    for (const midTurn of ['agent_completed', 'push_notification', 'auth_success']) {
      expect(types).not.toContain(midTurn)
    }
  })

  it('carries a statusLine next to the hooks when the built-in statusline is on', () => {
    const sl = { type: 'command' as const, command: "'/x/statusline/run.sh'", padding: 0 }
    const file = writeTabHookSettings(setupHooks(noPeerInstance), 'tabSL', sl)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(settings.statusLine).toEqual(sl)
    expect(settings.hooks.SessionStart).toBeTruthy()
  })

  it('omits statusLine when the toggle is off — the user’s own settings stay in charge', () => {
    const file = writeTabHookSettings(setupHooks(noPeerInstance), 'tabSL2')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).not.toHaveProperty('statusLine')
  })

  // CC§13
  it('lets the koloft command run without asking only when agent tools are on, and never puts that rule in the settings a remote tab shares', () => {
    const read = (file: string): Record<string, unknown> =>
      JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(
      read(writeTabHookSettings(setupHooks(noPeerInstance), 'tabAG1', undefined, true)).permissions
    ).toEqual({ allow: ['Bash(koloft *)'] })
    expect(read(writeTabHookSettings(setupHooks(noPeerInstance), 'tabAG2'))).not.toHaveProperty(
      'permissions'
    )
    expect(hookSettings('/x/hook.sh', '/x/reg', 'tabAG3')).not.toHaveProperty('permissions')
  })

  describe('a dialog Koloft can answer from Discord (PermissionRequest)', () => {
    const ask = {
      session_id: 's1',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf "build"', description: 'Clean' }
    }
    const runAsk = (tab: string): ReturnType<typeof spawn> =>
      spawn(hookScript, [regDir, tab, 'ask'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const feed = (child: ReturnType<typeof spawn>, payload: unknown): Promise<string> => {
      let out = ''
      child.stdout!.on('data', (c) => (out += c))
      child.stdin!.end(JSON.stringify(payload))
      return new Promise((resolve) => child.on('close', () => resolve(out)))
    }
    const hookFiles = (tab: string): string[] =>
      fs.readdirSync(regDir).filter((f) => f.startsWith(`${tab}.`) && /\.(ask|answer)\./.test(f))
    const askOf = (child: ReturnType<typeof spawn>, tab: string): string =>
      path.join(regDir, `${tab}.${child.pid}.ask.json`)

    // CC§14
    it('every local tab waits up to an hour for an answer to any dialog; a tab on another machine only records it', () => {
      const read = (file: string): Record<string, Record<string, unknown>> =>
        JSON.parse(fs.readFileSync(file, 'utf8'))
      const local = read(writeTabHookSettings(setupHooks(noPeerInstance), 'tabC1')).hooks
        .PermissionRequest as {
        matcher: string
        hooks: { command: string; timeout: number }[]
      }[]
      expect(local[0].matcher).toBe('*')
      expect(local[0].hooks[0].command).toMatch(/ ask$/)
      expect(local[0].hooks[0].timeout).toBe(3600)
      const remote = hookSettings('/m/hook.sh', '/m/reg', 'tabC2', undefined, dq, 'record-only')
        .hooks as Record<string, { hooks: { command: string; timeout?: number }[] }[]>
      expect(remote.PermissionRequest[0].hooks[0].command).toMatch(/ asked$/)
      expect(remote.PermissionRequest[0].hooks[0]).not.toHaveProperty('timeout')
    })

    // CC§14
    it('hands the question to Koloft in a file of its own, waits for its answer file and prints it, then cleans both files up', async () => {
      markAnswerable(regDir, 'tabA1', true)
      const child = runAsk('tabA1')
      const printed = feed(child, ask)
      const askFile = askOf(child, 'tabA1')
      await vi.waitFor(() => expect(fs.existsSync(askFile)).toBe(true))
      expect(JSON.parse(fs.readFileSync(askFile, 'utf8'))).toEqual(ask)
      fs.writeFileSync(path.join(regDir, `tabA1.${child.pid}.answer.json`), '{"decided":true}')
      expect(await printed).toBe('{"decided":true}')
      expect(hookFiles('tabA1')).toEqual([])
    })

    // CC§14
    it('ended by claude (the person answered "No" at the Mac), it removes its question file', async () => {
      markAnswerable(regDir, 'tabA2', true)
      const child = runAsk('tabA2')
      const closed = feed(child, ask)
      await vi.waitFor(() => expect(fs.existsSync(askOf(child, 'tabA2'))).toBe(true))
      child.kill('SIGTERM')
      await closed
      expect(hookFiles('tabA2')).toEqual([])
    })

    // CC§14
    it('for a tab not marked answerable (Discord off, in no conductor’s care, or a marker lost while Discord reconnected) it does not wait: it exits at once with no output and records the question in the status log, as on another machine', () => {
      const res = spawnSync(hookScript, [regDir, 'tabNotLookedAfter', 'ask'], {
        input: JSON.stringify(ask),
        encoding: 'utf8',
        timeout: 5000
      })
      expect(res.status).toBe(0)
      expect(res.stdout).toBe('')
      expect(fs.readdirSync(regDir).filter((f) => f.includes('.ask'))).toEqual([])
      expect(readStatusLog('tabNotLookedAfter')).toEqual([
        { tabId: 'tabNotLookedAfter', event: 'ask', sessionId: 's1', tmux: '', ask }
      ])
    })

    // CC§14
    it('on another machine it does not wait: it appends the whole question to the status log, which the mirror brings back', () => {
      fire('tabR1', 'asked', ask)
      expect(readStatusLog('tabR1')).toEqual([
        { tabId: 'tabR1', event: 'ask', sessionId: 's1', tmux: '', ask }
      ])
    })
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
    const { settingsDir } = setupHooks(noPeerInstance)
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

    setupHooks(noPeerInstance)

    for (const f of fresh) expect(fs.existsSync(f), f).toBe(true)
    for (const f of old) expect(fs.existsSync(f), f).toBe(false)
  })

  it('removes the answerable and conductor markers a crash left behind, and keeps a live peer instance’s however old they are', () => {
    const peerTab = 'pty-peer-1'
    const crashedTab = 'pty-gone-1'
    const markers = (tab: string): string[] => [
      path.join(regDir, `${tab}.answerable`),
      path.join(regDir, `${tab}.conductor`)
    ]
    markAnswerable(regDir, peerTab, true)
    writeConductorMarker(regDir, peerTab, 'role')
    markAnswerable(regDir, crashedTab, true)
    writeConductorMarker(regDir, crashedTab, 'role')
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000)
    for (const f of markers(peerTab)) fs.utimesSync(f, twoDaysAgo, twoDaysAgo)

    setupHooks((tab) => tab === peerTab)

    for (const f of markers(peerTab)) expect(fs.existsSync(f), f).toBe(true)
    for (const f of markers(crashedTab)) expect(fs.existsSync(f), f).toBe(false)
  })
})
