import { afterAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { MUSE_WRAP_PY, REMOTE_MUSE_HOOK_SH } from '../../src/main/museRemote'
import {
  NOT_FROM_THE_RELAY,
  NOTICE_SUFFIX,
  noticeLine,
  seedHandedOverOwnerWords
} from '../../src/main/hooks'
import { A_HELPER_HAS_IT, FROM_A_SESSION, FROM_KOLOFT } from '../../src/main/crossSessionMessage'
import * as museLog from '../../src/main/museSessionLog'

const SID = '019a0000-0000-7000-8000-000000000001'
const python = spawnSync('python3', ['-c', 'import pty, termios'], { encoding: 'utf8' })
const PYTHON_WITH_PTY = python.status === 0

const roots: string[] = []
afterAll(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true })
})

function machine(): { home: string; bin: string; env: NodeJS.ProcessEnv } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-muse-remote-')))
  roots.push(home)
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HOME/tmux-calls"\n`,
    { mode: 0o755 }
  )
  return {
    home,
    bin,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'conf'),
      XDG_DATA_HOME: path.join(home, 'data'),
      TMUX: '/tmp/fake-tmux,1,0',
      TMUX_PANE: '%7'
    }
  }
}

const FAKE_MUSE_JS = `
const fs = require('fs')
const path = require('path')
const ESC = '\\x1b'
const home = process.env.HOME
fs.writeFileSync(path.join(home, 'muse-argv'), JSON.stringify(process.argv.slice(2)))
const data = path.join(process.env.XDG_DATA_HOME, 'muse')
const sid = process.env.FAKE_SID
const ms = parseInt(sid.replace(/-/g, '').slice(0, 12), 16)
const d = new Date(ms)
const p2 = (n) => String(n).padStart(2, '0')
const logDir = path.join(data, 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()), sid)
fs.mkdirSync(logDir, { recursive: true })
const log = path.join(logDir, 'session.jsonl')
fs.writeFileSync(log, (process.env.FAKE_FIRST_RECORD || JSON.stringify({ payload_type: 'session.name.changed', payload: { new_name: 'before-bind', source: 'user' } })) + '\\n')
process.stdin.setRawMode(true)
let heard = ''
process.stdin.on('data', (chunk) => {
  heard += chunk.toString('latin1')
  if (!heard.includes(ESC + ']7501;?:states=')) return
  heard = ''
  process.stdout.write('hello ' + ESC + ']7501;state=idle:app=muse' + ESC + '\\\\ world')
  const reg = path.join(data, 'runtime', 'muse', 'sessions')
  fs.mkdirSync(reg, { recursive: true })
  fs.writeFileSync(path.join(reg, sid + '.json'), JSON.stringify({ schema_version: 1, session_id: sid, process_generation_hint: 'pid=' + process.pid }))
  setTimeout(() => {
    fs.appendFileSync(log, JSON.stringify({ payload_type: 'session.name.changed', payload: { new_name: 'renamed', source: 'user' } }) + '\\n')
    fs.appendFileSync(log, JSON.stringify({ payload_type: 'runtime.session', payload: { kind: 'run', event: { kind: 'assistant_message_committed', text: 'not forwarded' } } }) + '\\n')
    fs.appendFileSync(log, JSON.stringify({ payload_type: 'runtime.command.accepted', payload: { command_kind: 'context.compact.manual' } }) + '\\n')
    fs.appendFileSync(log, JSON.stringify({ payload_type: 'context.compact.manual.outcome', payload: { terminal_outcome: 'compacted' } }) + '\\n')
    process.stdout.write(ESC + ']7501;state=blocked:app=muse:kind=permission' + ESC + '\\\\')
  }, 1500)
  setTimeout(() => process.exit(7), 3000)
})
process.stdout.write(ESC + ']7501;?' + ESC + '\\\\')
`

function installFakeMuse(m: { home: string; bin: string }): void {
  const js = path.join(m.home, 'fake-muse.js')
  fs.writeFileSync(js, FAKE_MUSE_JS)
  fs.writeFileSync(
    path.join(m.bin, 'muse'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} "$@"\n`,
    { mode: 0o755 }
  )
}

function runWrapper(
  m: { home: string; env: NodeJS.ProcessEnv },
  extra: string[]
): Promise<{ code: number | null; out: string }> {
  const wrap = path.join(m.home, 'muse-wrap.py')
  fs.writeFileSync(wrap, MUSE_WRAP_PY)
  const hookDir = path.join(m.home, '.koloft', 'hook-sessions')
  return new Promise((resolve) => {
    const child = spawn(
      'python3',
      [wrap, hookDir, 'pty-1', ...extra, '--', 'muse', 'resume', SID],
      {
        env: { ...m.env, FAKE_SID: SID },
        stdio: ['pipe', 'pipe', 'inherit']
      }
    )
    let out = ''
    child.stdout.on('data', (c) => (out += c.toString('latin1')))
    child.on('exit', (code) => resolve({ code, out }))
  })
}

const lines = (file: string): Record<string, unknown>[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

describe.skipIf(!PYTHON_WITH_PTY)(
  'muse-wrap.py, the python3 pty wrapper a remote Muse tab runs in tmux',
  () => {
    it("answers Muse's status query itself, sends each state on as a numbered tmux passthrough and as a mirror line, names the tmux session after the bound session, forwards renames and a manual /compact's start and end from the log, and exits with Muse's code", async () => {
      const m = machine()
      installFakeMuse(m)
      const { code, out } = await runWrapper(m, [])
      expect(code).toBe(7)
      expect(out).toContain('hello ')
      expect(out).toContain(' world')
      expect(out).not.toContain('7501;?')
      expect(out).toContain('\x1bPtmux;\x1b\x1b]7501;state=idle:app=muse:seq=1\x1b\x1b\\\x1b\\')
      expect(out).toContain(
        '\x1bPtmux;\x1b\x1b]7501;state=blocked:app=muse:kind=permission:seq=2\x1b\x1b\\\x1b\\'
      )
      const hookDir = path.join(m.home, '.koloft', 'hook-sessions')
      const mirror = lines(path.join(hookDir, 'pty-1.muse.jsonl'))
      expect(mirror).toHaveLength(6)
      expect(mirror).toEqual(
        expect.arrayContaining([
          { t: 'state', seq: 1, state: 'idle', kind: null },
          { t: 'bound', sessionId: SID, forked: false },
          {
            t: 'log',
            seq: expect.any(Number),
            payloadType: 'session.name.changed',
            payload: { new_name: 'renamed', source: 'user' }
          },
          {
            t: 'log',
            seq: expect.any(Number),
            payloadType: 'runtime.command.accepted',
            payload: { command_kind: 'context.compact.manual' }
          },
          {
            t: 'log',
            seq: expect.any(Number),
            payloadType: 'context.compact.manual.outcome',
            payload: { terminal_outcome: 'compacted' }
          },
          { t: 'state', seq: 2, state: 'blocked', kind: 'permission' }
        ])
      )
      expect(fs.readFileSync(path.join(hookDir, `k-${SID}.muse.run`), 'utf8')).toBe('pty-1')
      expect(fs.readFileSync(path.join(m.home, '.koloft', 'tabs', 'pty-1.tmux'), 'utf8')).toBe(
        `k-${SID}`
      )
      expect(fs.readFileSync(path.join(m.home, 'tmux-calls'), 'utf8')).toBe(
        `rename-session -t %7 k-${SID}\n`
      )
    }, 15_000)

    it("says a session it binds to is a /fork copy when the session's log starts with the record Muse writes for one", async () => {
      const m = machine()
      installFakeMuse(m)
      m.env.FAKE_FIRST_RECORD = JSON.stringify({
        payload_type: 'session.fork.created',
        payload: { fork_session_id: SID, source_session_id: 'source' }
      })
      await runWrapper(m, [])
      const mirror = lines(path.join(m.home, '.koloft', 'hook-sessions', 'pty-1.muse.jsonl'))
      expect(mirror).toContainEqual({ t: 'bound', sessionId: SID, forked: true })
    }, 15_000)

    it('trusts the folders it is told to before Muse starts, and adds --trust-workspace only when the workspace it is asked about is trusted', async () => {
      const m = machine()
      installFakeMuse(m)
      const ws = path.join(m.home, 'ws')
      const tree = path.join(ws, '.claude', 'worktrees', 'one')
      fs.mkdirSync(tree, { recursive: true })
      const untrusted = path.join(m.home, 'other')
      fs.mkdirSync(untrusted)
      await runWrapper(m, ['--trust-if', untrusted])
      expect(JSON.parse(fs.readFileSync(path.join(m.home, 'muse-argv'), 'utf8'))).toEqual([
        'resume',
        SID
      ])
      await runWrapper(m, ['--trust', ws, '--trust', tree, '--trust-if', ws])
      const trust = JSON.parse(
        fs.readFileSync(path.join(m.home, 'conf', 'muse', 'trust.json'), 'utf8')
      )
      expect(trust).toEqual({
        schema_version: 1,
        projects: { [ws]: { decision: 'trusted' }, [tree]: { decision: 'trusted' } }
      })
      expect(JSON.parse(fs.readFileSync(path.join(m.home, 'muse-argv'), 'utf8'))).toEqual([
        '--trust-workspace',
        'resume',
        SID
      ])
    }, 20_000)
  }
)

describe('the session-log lines muse-wrap.py passes on', () => {
  const wrapperMarks = [
    ...MUSE_WRAP_PY.match(/^LOG_MARKS = \((.*)\)$/m)![1].matchAll(/b'([^']*)'/g)
  ].map((m) => m[1])
  const line = (payloadType: string, payload: Record<string, unknown>): string =>
    JSON.stringify({ payload_type: payloadType, payload })
  const queued = (source: Record<string, unknown>): string =>
    line('runtime.session', {
      event: { kind: 'inbox_item_queued', source, registered_work_id: 'w1' }
    })
  const renamed = line('session.name.changed', { new_name: 'n', source: 'user' })
  const scheduled = queued({ source: 'scheduled', job_id: 'j1' })
  const readersARemoteTabActsOn: [(r: museLog.LogRecord) => unknown, string][] = [
    [museLog.museNameOf, renamed],
    [museLog.renamedTo, renamed],
    [museLog.startsATurnByItself, scheduled],
    [museLog.firedJob, scheduled],
    [museLog.finishedWork, queued({ source: 'background_task_terminal' })],
    [
      museLog.compactionStarts,
      line('runtime.command.accepted', { command_kind: 'context.compact.manual' })
    ],
    [
      museLog.compactionEnds,
      line('context.compact.manual.outcome', { terminal_outcome: 'compacted' })
    ]
  ]
  const readersARemoteTabLeavesToItsHooks = ['replyIn', 'turnEndedIn']
  const readersTheWrapperRunsOnTheFirstLine = ['startsAsAFork']
  const notReaders = [
    'museHome',
    'museConfigHome',
    'museSessionLog',
    'logRecord',
    'lastCompletedText',
    'runEvent',
    'LineTail',
    'SessionLogTail',
    'textOfLogLine',
    'saidInLog'
  ]

  it.each(readersARemoteTabActsOn.map(([reader, l]) => [reader.name, reader, l] as const))(
    'a record %s acts on reaches a remote tab, because its line carries one of the marks the wrapper looks for',
    (_name, reader, l) => {
      expect(reader(museLog.logRecord(l)!)).toBeTruthy()
      expect(wrapperMarks.some((mark) => l.includes(mark))).toBe(true)
    }
  )

  it('every function the session-log module exports is a reader checked above, a reader a remote tab leaves to its hooks, or no reader at all', () => {
    const exported = Object.entries(museLog)
      .filter(([, v]) => typeof v === 'function')
      .map(([name]) => name)
    expect(exported.sort()).toEqual(
      [
        ...readersARemoteTabActsOn.map(([reader]) => reader.name),
        ...readersARemoteTabLeavesToItsHooks,
        ...readersTheWrapperRunsOnTheFirstLine,
        ...notReaders
      ].sort()
    )
  })
})

describe('muse-hook.sh, the hook a remote Muse tab runs', () => {
  it("appends each event as one whole line to its tab's mirror file, and hands Koloft's instructions over only at SessionStart", () => {
    const m = machine()
    const script = path.join(m.home, 'muse-hook.sh')
    fs.writeFileSync(script, REMOTE_MUSE_HOOK_SH)
    const ctx = path.join(m.home, 'ctx.json')
    fs.writeFileSync(ctx, '{"hookSpecificOutput":{}}')
    const run = (event: string, input: string): string =>
      spawnSync('bash', [script, 'pty-1', event, ctx], { env: m.env, input, encoding: 'utf8' })
        .stdout
    fs.mkdirSync(path.join(m.home, '.koloft', 'hook-sessions'), { recursive: true })
    fs.mkdirSync(path.join(m.home, '.koloft', 'tabs'), { recursive: true })
    expect(run('SessionStart', '{"session_id":"a",\n"source":"startup"}\n')).toBe(
      '{"hookSpecificOutput":{}}'
    )
    expect(run('Stop', '{\n  "session_id": "a",\n  "last_assistant_message": "hi"\n}\n')).toBe('')
    expect(lines(path.join(m.home, '.koloft', 'hook-sessions', 'pty-1.muse.jsonl'))).toEqual([
      { t: 'hook', event: 'SessionStart', input: { session_id: 'a', source: 'startup' } },
      { t: 'hook', event: 'Stop', input: { session_id: 'a', last_assistant_message: 'hi' } }
    ])
  })

  it("reminds Muse of the language of the owner's last message after every tool, as a local tab's hook does", () => {
    const m = machine()
    const script = path.join(m.home, 'muse-hook.sh')
    fs.writeFileSync(script, REMOTE_MUSE_HOOK_SH)
    for (const dir of ['hook-sessions', 'tabs'])
      fs.mkdirSync(path.join(m.home, '.koloft', dir), { recursive: true })
    const run = (event: string, input: string): string =>
      spawnSync('bash', [script, 'pty-1', event], { env: m.env, input, encoding: 'utf8' }).stdout
    run('UserPromptSubmit', JSON.stringify({ session_id: 'a', prompt: '请看一下这个文件' }))
    const said = JSON.parse(run('PostToolUse', '{"session_id":"a","tool_name":"read_file"}'))
    expect(said.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(said.hookSpecificOutput.additionalContext).toContain('The user writes Chinese')
  })

  it('hands what Koloft left for the tab on the machine to the next prompt or tool call, once, and its file goes', () => {
    const m = machine()
    const script = path.join(m.home, 'muse-hook.sh')
    fs.writeFileSync(script, REMOTE_MUSE_HOOK_SH)
    for (const dir of ['hook-sessions', 'tabs'])
      fs.mkdirSync(path.join(m.home, '.koloft', dir), { recursive: true })
    const notice = path.join(m.home, '.koloft', 'hook-sessions', `pty-1${NOTICE_SUFFIX}`)
    fs.writeFileSync(notice, noticeLine('(From Koloft:) origin/main moved.'))
    const run = (event: string, input: string): string =>
      spawnSync('bash', [script, 'pty-1', event], { env: m.env, input, encoding: 'utf8' }).stdout
    const told = JSON.parse(run('PostToolUse', '{"session_id":"a","tool_name":"read_file"}'))
    expect(told.hookSpecificOutput.additionalContext).toBe('(From Koloft:) origin/main moved.\n\n')
    expect(fs.existsSync(notice)).toBe(false)
    expect(run('PostToolUse', '{"session_id":"a","tool_name":"read_file"}')).toBe('')
  })

  // MUSE§9
  it('a turn about to end with a notice Koloft left still unread keeps going with it instead, with no Stop in the mirror for Koloft to end the turn on; the Stop after that is mirrored as usual', () => {
    const m = machine()
    const script = path.join(m.home, 'muse-hook.sh')
    fs.writeFileSync(script, REMOTE_MUSE_HOOK_SH)
    for (const dir of ['hook-sessions', 'tabs'])
      fs.mkdirSync(path.join(m.home, '.koloft', dir), { recursive: true })
    const notice = path.join(m.home, '.koloft', 'hook-sessions', `pty-1${NOTICE_SUFFIX}`)
    const mirror = path.join(m.home, '.koloft', 'hook-sessions', 'pty-1.muse.jsonl')
    fs.writeFileSync(notice, noticeLine('(From Koloft:) origin/main moved.'))
    const run = (input: string): string =>
      spawnSync('bash', [script, 'pty-1', 'Stop'], { env: m.env, input, encoding: 'utf8' }).stdout
    expect(JSON.parse(run('{"session_id":"a","stop_hook_active":false}'))).toEqual({
      decision: 'block',
      reason: '(From Koloft:) origin/main moved.\n\n'
    })
    expect(fs.existsSync(mirror)).toBe(false)
    expect(run('{"session_id":"a","stop_hook_active":true}')).toBe('')
    expect(lines(mirror)).toMatchObject([{ t: 'hook', event: 'Stop' }])
  })

  it("a message from another session, a notice from Koloft and the note Koloft opens a butler with for a ⌘P request keep the quote of the owner's own last prompt", () => {
    const m = machine()
    const script = path.join(m.home, 'muse-hook.sh')
    fs.writeFileSync(script, REMOTE_MUSE_HOOK_SH)
    for (const dir of ['hook-sessions', 'tabs'])
      fs.mkdirSync(path.join(m.home, '.koloft', dir), { recursive: true })
    const run = (event: string, input: string): string =>
      spawnSync('bash', [script, 'pty-1', event], { env: m.env, input, encoding: 'utf8' }).stdout
    run('UserPromptSubmit', JSON.stringify({ session_id: 'a', prompt: '请看一下这个文件' }))
    for (const notTheOwners of [
      `${FROM_A_SESSION}"Fix docs", id abc:) Done: PR #12 is open.`,
      `${FROM_KOLOFT}origin/main moved from aaaaaaa to bbbbbbb.`,
      A_HELPER_HAS_IT
    ])
      run('UserPromptSubmit', JSON.stringify({ session_id: 'a', prompt: notTheOwners }))
    const said = JSON.parse(run('PostToolUse', '{"session_id":"a","tool_name":"read_file"}'))
    expect(said.hookSpecificOutput.additionalContext).toContain('The user writes Chinese')
  })

  // ADR-0028
  it('flags every [Discord] prompt, as no relay writes down on the machine what it hands over, and keeps the quote', () => {
    const m = machine()
    const script = path.join(m.home, 'muse-hook.sh')
    fs.writeFileSync(script, REMOTE_MUSE_HOOK_SH)
    for (const dir of ['hook-sessions', 'tabs'])
      fs.mkdirSync(path.join(m.home, '.koloft', dir), { recursive: true })
    const run = (prompt: string): string =>
      spawnSync('bash', [script, 'pty-1', 'UserPromptSubmit'], {
        env: m.env,
        input: JSON.stringify({ session_id: 'a', prompt }),
        encoding: 'utf8'
      }).stdout
    run('look but do not change')
    const told = JSON.parse(run('[Discord] approve it')).hookSpecificOutput.additionalContext
    expect(told.startsWith(NOT_FROM_THE_RELAY)).toBe(true)
    expect(told).toContain('«look but do not change»')
  })

  it("a session another session started keeps the owner's language past the English task it was handed", () => {
    const m = machine()
    const script = path.join(m.home, 'muse-hook.sh')
    fs.writeFileSync(script, REMOTE_MUSE_HOOK_SH)
    for (const dir of ['hook-sessions', 'tabs'])
      fs.mkdirSync(path.join(m.home, '.koloft', dir), { recursive: true })
    seedHandedOverOwnerWords(path.join(m.home, '.koloft', 'tabs', 'pty-1.said'), '请修一下这个问题')
    const run = (event: string, input: string): string =>
      spawnSync('bash', [script, 'pty-1', event], { env: m.env, input, encoding: 'utf8' }).stdout
    run('UserPromptSubmit', JSON.stringify({ session_id: 'a', prompt: 'Fix the failing test' }))
    const said = JSON.parse(run('PostToolUse', '{"session_id":"a","tool_name":"read_file"}'))
    expect(said.hookSpecificOutput.additionalContext).toContain('The user writes Chinese')
  })
})
