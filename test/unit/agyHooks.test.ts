import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LineTail,
  agyHook,
  koloftHookEntry,
  titleState,
  writeAgyScripts,
  type AgyScripts
} from '../../src/main/agyHooks'

let dir: string
let drops: string
let scripts: AgyScripts

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hooks-')))
  drops = path.join(dir, 'drops')
  fs.mkdirSync(drops)
  scripts = writeAgyScripts(path.join(dir, 'scripts'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const BASE_ENV = { PATH: '/usr/bin:/bin', KOLOFT_AGY_DROPS: '' }

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
  koloftHookEntry(scripts.hook) as Record<string, unknown[]>

function commandFor(event: string): string {
  const [first] = entry()[event] as Record<string, unknown>[]
  const hooks = (first.hooks ?? [first]) as { command: string }[]
  return hooks[0].command
}

const hook = (event: string, input: unknown, env: Record<string, string> = {}): string =>
  run(commandFor(event), JSON.stringify(input), { KOLOFT_AGY_DROPS: drops, ...env })

const dropped = (): unknown[] =>
  fs
    .readdirSync(drops)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(drops, n), 'utf8')))

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

  it('hands Koloft session start, tool use and stop, each with what agy sent, and not the call before every model request', () => {
    const input = { conversationId: 'c1', workspacePaths: ['/w'], toolCall: { name: 'view_file' } }
    for (const event of ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'])
      hook(event, input)
    const got = dropped().map((d) => agyHook(d))
    expect(got.map((h) => h?.event).sort()).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop'
    ])
    for (const h of got) expect(h).toMatchObject({ conversationId: 'c1', input })
  })

  it('drops nothing when the tab gave it no folder, and still answers agy', () => {
    const start = path.join(dir, 'start.json')
    fs.writeFileSync(start, '{"injectSteps":[]}')
    expect(
      hook(
        'SessionStart',
        { conversationId: 'c1' },
        { KOLOFT_AGY_DROPS: '', KOLOFT_AGY_START: start }
      )
    ).toBe('{"injectSteps":[]}')
    expect(fs.readdirSync(drops)).toEqual([])
  })

  it('prints the session-start words at SessionStart and the every-turn words before each model call, from the files the tab names', () => {
    const start = path.join(dir, 'start.json')
    const turn = path.join(dir, 'turn.json')
    fs.writeFileSync(start, 'START')
    const env = { KOLOFT_AGY_START: start, KOLOFT_AGY_TURN: turn }
    expect(hook('SessionStart', { conversationId: 'c1' }, env)).toBe('START')
    expect(hook('PreInvocation', { conversationId: 'c1' }, env)).toBe('')
    fs.writeFileSync(turn, 'TURN')
    expect(hook('PreInvocation', { conversationId: 'c1' }, env)).toBe('TURN')
    expect(hook('Stop', { conversationId: 'c1' }, env)).toBe('')
  })

  it("passes a tool call to the tab's gate on stdin and prints the gate's verdict", () => {
    const seen = path.join(dir, 'seen.json')
    const gate = `cat > '${seen}'; printf '{"decision":"deny","reason":"no"}'`
    const input = { conversationId: 'c1', toolCall: { name: 'search_web', args: {} } }
    expect(hook('PreToolUse', input, { KOLOFT_AGY_GATE: gate })).toBe(
      '{"decision":"deny","reason":"no"}'
    )
    expect(JSON.parse(fs.readFileSync(seen, 'utf8'))).toEqual(input)
  })

  it('prints nothing at all for a tool call when the tab has no gate, since agy reads even {} as a deny', () => {
    expect(
      hook('PreToolUse', { conversationId: 'c1', toolCall: { name: 'run_command', args: {} } })
    ).toBe('')
  })
})

describe('the title script agy runs on every state change (AGY§9 AGY§11)', () => {
  const titleCommand = (): string => `/bin/sh ${JSON.stringify(scripts.title)}`

  it('appends what agy sent as one line per run, even when agy pretty-prints it', () => {
    const log = path.join(dir, 'title.jsonl')
    const first = { conversation_id: 'c1', agent_state: 'idle' }
    const second = { conversation_id: 'c2', agent_state: 'working' }
    run(titleCommand(), JSON.stringify(first, null, 2), { KOLOFT_AGY_TITLE_LOG: log })
    run(titleCommand(), JSON.stringify(second), { KOLOFT_AGY_TITLE_LOG: log })
    const lines = fs.readFileSync(log, 'utf8').split('\n')
    expect(lines.pop()).toBe('')
    expect(lines.map((l) => JSON.parse(l))).toEqual([first, second])
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

describe('reading what the scripts left', () => {
  it("reads agy's state, title, context use and model from a title line", () => {
    expect(
      titleState(
        JSON.stringify({
          conversation_id: 'c1',
          agent_state: 'reviewing',
          conversation_title: 'Docs',
          context_window: { used_percentage: 12.5 },
          model: { id: 'gemini-3.1-pro-low' }
        })
      )
    ).toEqual({
      conversationId: 'c1',
      agentState: 'reviewing',
      title: 'Docs',
      contextUsed: 12.5,
      model: 'gemini-3.1-pro-low'
    })
  })

  it('reads the empty id and null model and title agy sends before the first prompt, and nothing from a broken line', () => {
    expect(
      titleState(
        JSON.stringify({
          conversation_id: '',
          agent_state: 'authenticating',
          model: null,
          conversation_title: null
        })
      )
    ).toEqual({ conversationId: '', agentState: 'authenticating' })
    expect(titleState('{"agent_state":"idle"}')).toBeUndefined()
    expect(titleState('not json')).toBeUndefined()
  })

  it('takes a hook drop only for an event it knows and with a conversation id', () => {
    expect(agyHook({ event: 'PostInvocation', input: { conversationId: 'c1' } })).toBeUndefined()
    expect(agyHook({ event: 'Stop', input: {} })).toBeUndefined()
    expect(agyHook({ event: 'Stop', input: { conversationId: 'c1', fullyIdle: true } })).toEqual({
      event: 'Stop',
      conversationId: 'c1',
      input: { conversationId: 'c1', fullyIdle: true }
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
