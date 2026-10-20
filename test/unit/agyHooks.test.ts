import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agyLogLine,
  koloftHookEntry,
  localAgyHold,
  runWithSh,
  writeAgyScripts,
  type AgyScripts
} from '../../src/main/agyHooks'
import { HOLD_HOOK_TIMEOUT_S, HOLD_SCRIPT } from '../../src/main/resourceGuard'
import { BUSY_MARKER } from '../../src/main/machineRoom'
import { handoverPreamble, withHandover } from '../../src/main/handover'
import { LineTail } from '../../src/main/museSessionLog'
import {
  REPLY_LANGUAGE_AFTER_QUOTE,
  REPLY_LANGUAGE_BEFORE_QUOTE,
  noticeLine
} from '../../src/main/hooks'

let dir: string
let log: string
let scripts: AgyScripts

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hooks-')))
  log = path.join(dir, 'agy.jsonl')
  scripts = writeAgyScripts(path.join(dir, 'scripts'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const BASE_ENV = { PATH: '/usr/bin:/bin', KOLOFT_AGY_LOG: '' }

function run(command: string, input: string, env: Record<string, string> = {}): string {
  const res = spawnSync('/bin/sh', ['-c', command], {
    input,
    encoding: 'utf8',
    env: { ...BASE_ENV, ...env }
  })
  if (res.status !== 0) throw new Error(`exited ${res.status}: ${res.stderr}`)
  return res.stdout
}

const entry = (): Record<string, unknown[]> =>
  koloftHookEntry(runWithSh(scripts.hook)) as Record<string, unknown[]>

function commandFor(event: string): string {
  const [first] = entry()[event] as Record<string, unknown>[]
  const hooks = (first.hooks ?? [first]) as { command: string }[]
  return hooks[0].command
}

const hook = (event: string, input: unknown, env: Record<string, string> = {}): string =>
  run(commandFor(event), JSON.stringify(input), { KOLOFT_AGY_LOG: log, ...env })

const logged = (): ReturnType<typeof agyLogLine>[] =>
  fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => agyLogLine(l))

function transcriptWith(...prompts: string[]): string {
  const file = path.join(dir, 'transcript_full.jsonl')
  const lines = prompts.flatMap((p, i) => [
    JSON.stringify({
      step_index: 2 * i,
      type: 'USER_INPUT',
      content: `<USER_REQUEST>\n${p}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>`
    }),
    JSON.stringify({ step_index: 2 * i + 1, type: 'PLANNER_RESPONSE', content: 'ok' })
  ])
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

const quoteBeforeModelCall = (transcriptPath: string): string | undefined => {
  const out = hook('PreInvocation', { conversationId: 'c1', transcriptPath })
  if (!out) return undefined
  const message = JSON.parse(out).injectSteps[0].ephemeralMessage as string
  return /«(.*)»/s.exec(message)![1]
}

describe('the hook script agy runs for every hook (AGY§12)', () => {
  it('runs the plain events from a flat list and the tool events behind a "*" matcher, as agy reads them', () => {
    const e = entry()
    for (const event of ['SessionStart', 'PreInvocation', 'Stop'])
      expect(e[event], event).toEqual([{ type: 'command', command: expect.any(String) }])
    for (const event of ['PreToolUse', 'PostToolUse'])
      expect(e[event], event).toEqual([
        { matcher: '*', hooks: [{ type: 'command', command: expect.any(String) }] }
      ])
  })

  it('appends every event with what agy sent, one line each in the order they ran, even when agy pretty-prints its input', () => {
    const input = { conversationId: 'c1', workspacePaths: ['/w'], toolCall: { name: 'view_file' } }
    const events = ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop']
    for (const event of events)
      run(commandFor(event), JSON.stringify(input, null, 2), { KOLOFT_AGY_LOG: log })
    expect(logged()).toEqual(
      events.map((event) => ({ hook: { event, conversationId: 'c1', input } }))
    )
  })

  it('writes nothing when the tab gave it no log, and still answers agy', () => {
    const start = path.join(dir, 'start.json')
    fs.writeFileSync(start, '{"injectSteps":[]}')
    expect(
      hook(
        'SessionStart',
        { conversationId: 'c1' },
        { KOLOFT_AGY_LOG: '', KOLOFT_AGY_START: start }
      )
    ).toBe('{"injectSteps":[]}')
    expect(fs.existsSync(log)).toBe(false)
  })

  it('prints the session-start words at SessionStart from the file the tab names, and nothing at Stop', () => {
    const start = path.join(dir, 'start.json')
    fs.writeFileSync(start, 'START')
    expect(hook('SessionStart', { conversationId: 'c1' }, { KOLOFT_AGY_START: start })).toBe(
      'START'
    )
    expect(hook('Stop', { conversationId: 'c1' })).toBe('')
  })

  // ADR-0031
  it("before each model call quotes the owner's newest message from the transcript agy names, already this turn's", () => {
    expect(
      quoteBeforeModelCall(transcriptWith('first words', '第二句 "quoted"\n\nnext line'))
    ).toBe('第二句 "quoted" next line')
  })

  it('hands what Koloft left for the tab to the next model call ahead of the quote, once, with no prompt to quote too, and its file goes', () => {
    const notice = path.join(dir, 'tab.notice')
    const ephemeral = (transcriptPath: string): string | undefined => {
      const out = hook(
        'PreInvocation',
        { conversationId: 'c1', transcriptPath },
        {
          KOLOFT_NOTICE: notice
        }
      )
      return out ? (JSON.parse(out).injectSteps[0].ephemeralMessage as string) : undefined
    }
    fs.writeFileSync(notice, noticeLine('(From Koloft:) origin/main moved: "fix: \\"x\\"".'))
    expect(ephemeral(transcriptWith('look around'))).toBe(
      `(From Koloft:) origin/main moved: "fix: \\"x\\"".\n\n${REPLY_LANGUAGE_BEFORE_QUOTE}look around${REPLY_LANGUAGE_AFTER_QUOTE}`
    )
    expect(fs.existsSync(notice)).toBe(false)
    expect(ephemeral(transcriptWith('look around'))).toMatch(/^The user's latest/)
    fs.writeFileSync(notice, noticeLine('(From Koloft:) main moved.'))
    expect(ephemeral(path.join(dir, 'missing.jsonl'))).toBe('(From Koloft:) main moved.\n\n')
  })

  // ADR-0031
  it('leaves out the handover Koloft puts before a task it hands to a new session', () => {
    const task = withHandover(
      handoverPreamble({ name: 'Global-conductor', id: 'abc-123', label: 'Claude' }),
      '评估管家的权限范围'
    )
    expect(quoteBeforeModelCall(transcriptWith(task))).toBe('评估管家的权限范围')
    const translated = withHandover(
      'Koloft 启动了你，因为会话 "Global-conductor" 让它这样做。完成后运行: koloft session send abc-123 "<your result>"',
      '先别改代码'
    )
    expect(quoteBeforeModelCall(transcriptWith(translated))).toBe('先别改代码')
  })

  // ADR-0031
  it('quotes at most 300 bytes, cut only between whole characters, and says nothing without a transcript', () => {
    for (let pad = 0; pad < 6; pad++) {
      for (const body of ['中文'.repeat(100), '😀é'.repeat(80)]) {
        const text = 'x'.repeat(pad) + body
        const quote = quoteBeforeModelCall(transcriptWith(text))!
        expect(text.startsWith(quote), JSON.stringify({ pad, quote })).toBe(true)
        expect(Buffer.byteLength(quote)).toBeLessThanOrEqual(300)
        expect(Buffer.byteLength(quote)).toBeGreaterThan(296)
      }
    }
    expect(quoteBeforeModelCall(path.join(dir, 'missing.jsonl'))).toBeUndefined()
  })

  // ADR-0043 AGY§12
  it('holds a run_command while the Mac is busy only in a tab Koloft marked as background, under an hour-long timeout, since agy denies a tool whose hook it kills', async () => {
    const reg = path.join(dir, 'reg')
    fs.mkdirSync(reg)
    const file = path.join(dir, 'hold.sh')
    fs.writeFileSync(file, HOLD_SCRIPT)
    fs.writeFileSync(path.join(reg, BUSY_MARKER), '')
    const [group] = koloftHookEntry(runWithSh(scripts.hook), localAgyHold({ file, regDir: reg }))
      .PreToolUse as { matcher: string; hooks: { command: string; timeout?: number }[] }[]
    const [, hold] = group.hooks
    expect(hold.timeout).toBe(HOLD_HOOK_TIMEOUT_S)
    const input = JSON.stringify({
      conversationId: 'c1',
      toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } }
    })
    const owners = spawnSync('/bin/sh', ['-c', hold.command], {
      input,
      encoding: 'utf8',
      env: BASE_ENV,
      timeout: 3000
    })
    expect(owners).toMatchObject({ status: 0, stdout: '' })
    const kid = spawn('/bin/sh', ['-c', hold.command], {
      env: { ...BASE_ENV, KOLOFT_HOLD_TAB: 'pty-bg' }
    })
    kid.stdin.end(input)
    await vi.waitFor(
      () => expect(fs.readdirSync(reg).some((n) => /^pty-bg\.\d+\.held$/.test(n))).toBe(true),
      { timeout: 3000 }
    )
    fs.writeFileSync(path.join(reg, 'pty-bg.free'), '')
    await new Promise((resolve) => kid.on('exit', resolve))
  })

  it('prints nothing at all for a tool call, since agy reads even {} as a deny', () => {
    expect(
      hook('PreToolUse', { conversationId: 'c1', toolCall: { name: 'run_command', args: {} } })
    ).toBe('')
  })
})

describe('the title script agy runs on every state change (AGY§9 AGY§11)', () => {
  const titleCommand = (): string => runWithSh(scripts.title)

  it('appends what agy sent to the same log as one line per run, even when agy pretty-prints it', () => {
    const first = { conversation_id: 'c1', agent_state: 'idle' }
    const second = { conversation_id: 'c2', agent_state: 'working' }
    run(titleCommand(), JSON.stringify(first, null, 2), { KOLOFT_AGY_LOG: log })
    run(titleCommand(), JSON.stringify(second), { KOLOFT_AGY_LOG: log })
    expect(logged()).toEqual([
      { title: { conversationId: 'c1', agentState: 'idle', confirmationPending: false } },
      { title: { conversationId: 'c2', agentState: 'working', confirmationPending: false } }
    ])
  })

  it("runs the owner's own title command with the same input and shows its output, and shows nothing without one", () => {
    const input = JSON.stringify({ conversation_id: 'c1', conversation_title: 'Docs' })
    const owner = `/usr/bin/sed -e 's/^/owner saw: /'`
    expect(run(titleCommand(), input, { KOLOFT_AGY_OWNER_TITLE: owner }).trimEnd()).toBe(
      `owner saw: ${input}`
    )
    expect(run(titleCommand(), input)).toBe('')
  })
})

describe('reading the log the scripts leave', () => {
  it("reads agy's state, an open ask, title, context use and model from a title line", () => {
    expect(
      agyLogLine(
        JSON.stringify({
          conversation_id: 'c1',
          agent_state: 'tool_use',
          tool_confirmation_pending: true,
          conversation_title: 'Docs',
          context_window: { used_percentage: 12.5 },
          model: { id: 'gemini-3.1-pro-low' }
        })
      )
    ).toEqual({
      title: {
        conversationId: 'c1',
        agentState: 'tool_use',
        confirmationPending: true,
        title: 'Docs',
        contextUsed: 12.5,
        model: 'gemini-3.1-pro-low'
      }
    })
  })

  it('reads the empty id and null model and title agy sends before the first prompt, and nothing from a broken line', () => {
    expect(
      agyLogLine(
        JSON.stringify({
          conversation_id: '',
          agent_state: 'authenticating',
          model: null,
          conversation_title: null
        })
      )
    ).toEqual({
      title: { conversationId: '', agentState: 'authenticating', confirmationPending: false }
    })
    expect(agyLogLine('{"agent_state":"idle"}')).toBeUndefined()
    expect(agyLogLine('not json')).toBeUndefined()
  })

  it('takes a hook line only for an event it knows and with a conversation id', () => {
    const line = (v: unknown): string => JSON.stringify(v)
    expect(agyLogLine(line({ event: 'PostInvocation', input: { conversationId: 'c1' } }))).toBe(
      undefined
    )
    expect(agyLogLine(line({ event: 'Stop', input: {} }))).toBeUndefined()
    expect(
      agyLogLine(line({ event: 'Stop', input: { conversationId: 'c1', fullyIdle: true } }))
    ).toEqual({
      hook: {
        event: 'Stop',
        conversationId: 'c1',
        input: { conversationId: 'c1', fullyIdle: true }
      }
    })
  })

  it('hands on each whole new line once, and holds a half-written line until its end arrives', () => {
    const file = path.join(dir, 'tail.jsonl')
    const lines: string[] = []
    const tail = new LineTail(file, (l) => lines.push(l))
    tail.read()
    fs.writeFileSync(file, 'one\ntw')
    tail.read()
    expect(lines).toEqual(['one'])
    fs.appendFileSync(file, 'o\n\nthree\n')
    tail.read()
    tail.read()
    expect(lines).toEqual(['one', 'two', 'three'])
  })
})
