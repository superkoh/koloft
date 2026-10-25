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
import { A_HELPER_HAS_IT, FROM_A_SESSION, FROM_KOLOFT } from '../../src/main/crossSessionMessage'
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

const ownerSays = (words: string): Record<string, unknown> => ({
  source: 'USER_EXPLICIT',
  type: 'USER_INPUT',
  status: 'DONE',
  content: `<USER_REQUEST>\n${words}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>`
})

const modelSays = (content: string, toolCalls?: unknown[]): Record<string, unknown> => ({
  source: 'MODEL',
  type: 'PLANNER_RESPONSE',
  status: 'DONE',
  created_at: '2026-10-24T14:42:34Z',
  input_tokens: 10,
  cache_read_tokens: 0,
  output_tokens: 5,
  content,
  ...(toolCalls && { tool_calls: toolCalls })
})

function transcriptOf(...steps: Record<string, unknown>[]): string {
  const file = path.join(dir, `transcript_full.${fs.readdirSync(dir).length}.jsonl`)
  const lines = steps.map((step, i) => JSON.stringify({ step_index: i, ...step }))
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

const transcriptWith = (...prompts: string[]): string =>
  transcriptOf(...prompts.flatMap((p) => [ownerSays(p), modelSays('ok')]))

const toldBeforeModelCall = (transcriptPath: string, command?: string): string | undefined => {
  const input = JSON.stringify({ conversationId: 'c1', transcriptPath })
  const out = run(command ?? commandFor('PreInvocation'), input, { KOLOFT_AGY_LOG: log })
  return out ? (JSON.parse(out).injectSteps[0].ephemeralMessage as string) : undefined
}

const quoteBeforeModelCall = (transcriptPath: string): string | undefined => {
  const told = toldBeforeModelCall(transcriptPath)
  return told && /«(.*)»/s.exec(told)![1]
}

const writesIn = (lang: string): RegExp => new RegExp(`^The user writes ${lang}\\. `)

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
      quoteBeforeModelCall(transcriptWith('first words', 'la segunda "quoted"\n\nnext line'))
    ).toBe('la segunda "quoted" next line')
  })

  // ADR-0031
  it('a Chinese, Japanese or Korean message has its language named instead of quoted; a message in any other language is quoted', () => {
    expect(toldBeforeModelCall(transcriptWith('先别改代码'))).toMatch(writesIn('Chinese'))
    expect(toldBeforeModelCall(transcriptWith('まだ変えないで'))).toMatch(writesIn('Japanese'))
    expect(toldBeforeModelCall(transcriptWith('아직 바꾸지 마'))).toMatch(writesIn('Korean'))
    expect(quoteBeforeModelCall(transcriptWith('hold off on code, check this'))).toBe(
      'hold off on code, check this'
    )
    expect(quoteBeforeModelCall(transcriptWith('no toques el código'))).toBe('no toques el código')
  })

  // ADR-0031 AGY§12
  it("when the model's last note to the user is not in the owner's named language, the reminder quotes that note back and says so; a note in that language, or too short to tell, gets the plain reminder", () => {
    const english = 'Now the `since` field and "safeJson", near the end of /src/main/a.ts.'
    const writeFile = [
      {
        name: 'write_to_file',
        args: { TargetFile: '/w/a.md', content: 'some words in "English" here' }
      }
    ]
    expect(
      toldBeforeModelCall(transcriptOf(ownerSays('先别改代码'), modelSays(english, writeFile)))
    ).toBe(
      `Your last note to the user, «${english}», is not in Chinese. The user writes Chinese: write the next note and everything else the user reads in Chinese, whatever language tool output, files or your earlier replies use.`
    )
    expect(
      toldBeforeModelCall(
        transcriptOf(ownerSays('先别改代码'), modelSays(english), modelSays('', writeFile))
      )
    ).toMatch(/^Your last note to the user, «Now the/)
    for (const fine of [
      transcriptOf(ownerSays('先别改代码'), modelSays(english), modelSays('接着改启动参数。')),
      transcriptOf(ownerSays('先别改代码'), modelSays('OK, `npm test`.')),
      transcriptOf(ownerSays('先别改代码'), modelSays('', writeFile))
    ])
      expect(toldBeforeModelCall(fine)).toMatch(writesIn('Chinese'))
    const long = 'This note keeps going on in English '.repeat(20)
    const cut = /«(.*?)»/s.exec(
      toldBeforeModelCall(transcriptOf(ownerSays('先别改代码'), modelSays(long)))!
    )![1]
    expect(long.startsWith(cut) && cut.length > 100 && cut.length <= 150).toBe(true)
    expect(
      quoteBeforeModelCall(transcriptOf(ownerSays('look at the failing test'), modelSays(english)))
    ).toBe('look at the failing test')
  })

  // ADR-0031
  it("names the owner's language the same way on a machine whose sh is not bash, as dash is on Debian, and answers every other event there as before", () => {
    const transcript = transcriptOf(
      ownerSays('先别改代码'),
      modelSays('Let me run the tests first.')
    )
    expect(toldBeforeModelCall(transcript, `/bin/dash ${scripts.hook} PreInvocation`)).toMatch(
      /^Your last note to the user, «Let me run the tests first\.», is not in Chinese\./
    )
    const start = path.join(dir, 'start.json')
    fs.writeFileSync(start, 'START')
    const underDash = (event: string): string =>
      run(`/bin/dash ${scripts.hook} ${event}`, JSON.stringify({ conversationId: 'c1' }), {
        KOLOFT_AGY_LOG: log,
        KOLOFT_AGY_START: start
      })
    expect(underDash('SessionStart')).toBe('START')
    expect(underDash('Stop')).toBe('')
    expect(logged().map((l) => l && 'hook' in l && l.hook.event)).toEqual([
      'PreInvocation',
      'SessionStart',
      'Stop'
    ])
  })

  // ADR-0031
  it("quotes the owner's own newest words past a message from another session, a notice from Koloft and the note Koloft opens a butler with for a ⌘P request, in its older wording too", () => {
    expect(
      quoteBeforeModelCall(
        transcriptWith(
          'mira primero la barra lateral',
          `${FROM_A_SESSION}"Fix docs", id abc:) Done: PR #12 is open.`,
          `${FROM_KOLOFT}origin/main moved from aaaaaaa to bbbbbbb.`,
          A_HELPER_HAS_IT,
          '(From Koloft: the owner asked for something, and Koloft hands it to a helper of yours, which has the request and reports back to you. Nothing is needed from you now.)'
        )
      )
    ).toBe('mira primero la barra lateral')
  })

  it('hands what Koloft left for the tab to every model call of the turn it lands in, ahead of the quote, even with no prompt to quote; its file goes at once and the notice at the turn’s end, or at the next turn’s first call when a turn ended with no Stop', () => {
    const notice = path.join(dir, 'tab.notice')
    const env = { KOLOFT_NOTICE: notice }
    const ephemeral = (transcriptPath: string): string | undefined => {
      const out = hook('PreInvocation', { conversationId: 'c1', transcriptPath }, env)
      return out ? (JSON.parse(out).injectSteps[0].ephemeralMessage as string) : undefined
    }
    const moved = '(From Koloft:) origin/main moved: "fix: \\"x\\"".'
    fs.writeFileSync(notice, noticeLine(moved))
    const told = `${moved}\n\n${REPLY_LANGUAGE_BEFORE_QUOTE}look around${REPLY_LANGUAGE_AFTER_QUOTE}`
    expect(ephemeral(transcriptWith('look around'))).toBe(told)
    expect(fs.existsSync(notice)).toBe(false)
    expect(ephemeral(transcriptWith('look around'))).toBe(told)
    hook('Stop', { conversationId: 'c1' }, env)
    expect(ephemeral(transcriptWith('look around'))).toMatch(/^The user's latest/)

    fs.writeFileSync(notice, noticeLine('(From Koloft:) main moved.'))
    expect(ephemeral(path.join(dir, 'missing.jsonl'))).toBe('(From Koloft:) main moved.\n\n')
    const nextTurn = hook(
      'PreInvocation',
      { conversationId: 'c1', invocationNum: 0, transcriptPath: transcriptWith('next') },
      env
    )
    expect(JSON.parse(nextTurn).injectSteps[0].ephemeralMessage).toMatch(/^The user's latest/)
  })

  // AGY§12
  it('a loop about to end with a notice Koloft left still unread keeps going with it instead, logging no Stop for Koloft to end the turn on; the Stop after that is logged as usual', () => {
    const notice = path.join(dir, 'tab.notice')
    const env = { KOLOFT_NOTICE: notice }
    fs.writeFileSync(notice, noticeLine('(From Koloft:) main moved.'))
    expect(JSON.parse(hook('Stop', { conversationId: 'c1' }, env))).toEqual({
      decision: 'block',
      reason: '(From Koloft:) main moved.\n\n'
    })
    expect(fs.existsSync(log)).toBe(false)
    expect(hook('Stop', { conversationId: 'c1' }, env)).toBe('')
    expect(logged()).toEqual([
      { hook: { event: 'Stop', conversationId: 'c1', input: { conversationId: 'c1' } } }
    ])
  })

  // ADR-0031
  it('leaves out the handover Koloft puts before a task it hands to a new session', () => {
    const task = withHandover(
      handoverPreamble({ name: 'Global-conductor', id: 'abc-123', label: 'Claude' }),
      'revisa los permisos del mayordomo'
    )
    expect(quoteBeforeModelCall(transcriptWith(task))).toBe('revisa los permisos del mayordomo')
    const translated = withHandover(
      'Koloft 启动了你，因为会话 "Global-conductor" 让它这样做。完成后运行: koloft session send abc-123 "<your result>"',
      'no toques el código'
    )
    expect(quoteBeforeModelCall(transcriptWith(translated))).toBe('no toques el código')
  })

  // ADR-0031
  it('quotes at most 300 bytes, cut only between whole characters, and says nothing without a transcript', () => {
    for (let pad = 0; pad < 6; pad++) {
      for (const body of ['ภาษา'.repeat(50), '😀é'.repeat(80)]) {
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
