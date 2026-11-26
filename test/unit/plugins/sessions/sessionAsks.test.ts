import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SessionStatus } from '../../../../src/shared/types'
import {
  A_TAKEN_ANSWER_SHOWS_WITHIN_MS,
  ANSWER_NOT_TAKEN,
  codexDialog,
  ONE_LINE_PER_QUESTION,
  type CodexQuestion
} from '../../../../src/plugins/sessions/main/dialog'
import {
  ANSWER_ON_ITS_WAY,
  inputNotProbed,
  PICKS_MAY_STILL_BE_TICKED,
  SessionAsks,
  SHOWS_NO_DIALOG,
  STARTED_IN_THE_TERMINAL,
  type SessionAskDeps
} from '../../../../src/plugins/sessions/main/sessionAsks'
import { typeKeys } from '../../../../src/core/typeKeys'

const TAB = 'pty-x-1'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-asks-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function setup(more: Partial<SessionAskDeps> = {}) {
  const writes: { data: string; at: number }[] = []
  const asksChanged: string[] = []
  const answered: { tab: string; reply: string }[] = []
  const session = { takesKeys: true }
  const deps: SessionAskDeps = {
    showsPromptBeforeBind: () => false,
    boundKey: () => 'session-1',
    queueDrained: () => true,
    backendOf: () => 'claude',
    status: (): SessionStatus => 'waiting',
    awaitsInput: () => false,
    turnOver: (t) => ['waiting', 'idle'].includes(deps.status(t) ?? ''),
    type: async (t, keys, stillWanted) => {
      const typed = await typeKeys(
        (data) => writes.push({ data, at: Date.now() }),
        keys,
        stillWanted
      )
      if (typed && session.takesKeys) asks.dialogGone(t, false)
      return typed
    },
    touchedSinceAsked: () => false,
    ownerTouchedSince: () => false,
    pendingApproval: () => undefined,
    pendingQuestion: () => undefined,
    answerable: async () => undefined,
    answerInPlace: async () => false,
    showsDialogsClosing: () => false,
    regDir: dir,
    ...more
  }
  const asks = new SessionAsks(deps)
  asks.listen({
    asksChanged: (t) => void asksChanged.push(t),
    answered: (tab, reply) => void answered.push({ tab, reply })
  })
  return { asks, session, writes, asksChanged, answered }
}

const HOOK = '4242'
const hookFile = (tab: string, suffix: string, hook = HOOK): string =>
  path.join(dir, `${tab}.${hook}.${suffix}.json`)
const drop = (file: string, payload: unknown): void =>
  fs.writeFileSync(file, JSON.stringify(payload))
const QUESTION = {
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }
}
// CC§14
const TO_THE_EMPTIED_FIELD_OF_TWO = [...Array<string>(4).fill('\x1b[B'), '\x1b[A', '\x15']

async function watchAsksOnceArmed(
  asks: SessionAsks,
  asksChanged: string[]
): Promise<fs.FSWatcher | null> {
  const watcher = asks.watchAsks()
  await vi.waitFor(() => {
    drop(hookFile('armed', 'ask'), QUESTION)
    expect(asksChanged).toContain('armed')
  })
  asksChanged.length = 0
  return watcher
}

describe('SessionAsks: a dialog of a session a conductor looks after', () => {
  const MANAGED = 'pty-x-2'
  const BASH = { tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Clean' } }

  // CC§14
  it('an approval answered yes is allowed with its input, no is denied with the words', async () => {
    const { asks, asksChanged } = setup()
    const watcher = await watchAsksOnceArmed(asks, asksChanged)
    for (const [reply, decision] of [
      ['yes', { behavior: 'allow', updatedInput: BASH.tool_input }],
      ['no, use make clean', { behavior: 'deny', message: 'no, use make clean' }]
    ] as const) {
      fs.rmSync(hookFile(MANAGED, 'answer'), { force: true })
      drop(hookFile(MANAGED, 'ask'), BASH)
      await vi.waitFor(() => expect(asks.dialog(MANAGED)).toBeDefined())
      expect(await asks.answerSession(MANAGED, reply)).toBeUndefined()
      expect(
        JSON.parse(fs.readFileSync(hookFile(MANAGED, 'answer'), 'utf8')).hookSpecificOutput.decision
      ).toEqual(decision)
      fs.rmSync(hookFile(MANAGED, 'ask'))
    }
    expect(await asks.answerSession(MANAGED, 'yes')).toBe(SHOWS_NO_DIALOG)
    watcher?.close()
  })

  // CC§14
  it('a newer dialog on the same tab lets the older hook, answered at the Mac, go; a result of another call leaves the open one alone', async () => {
    const { asks, asksChanged } = setup()
    const watcher = await watchAsksOnceArmed(asks, asksChanged)
    drop(hookFile(MANAGED, 'ask', '1'), BASH)
    await vi.waitFor(() => expect(asks.dialog(MANAGED)?.text).toContain('rm -rf build'))
    const next = { tool_name: 'Bash', tool_input: { command: 'make' } }
    drop(hookFile(MANAGED, 'ask', '2'), next)
    await vi.waitFor(() => expect(fs.existsSync(hookFile(MANAGED, 'answer', '1'))).toBe(true))
    expect(JSON.parse(fs.readFileSync(hookFile(MANAGED, 'answer', '1'), 'utf8'))).toEqual({})
    asks.toolDone(MANAGED, { name: 'Bash', input: BASH.tool_input })
    expect(fs.existsSync(hookFile(MANAGED, 'answer', '2'))).toBe(false)
    expect(asks.dialog(MANAGED)?.text).toBe('Claude asks to run: make')
    watcher?.close()
  })

  // CC§14
  it('a Claude session on another machine is answered by keys as soon as its mirrored question arrives, and not once its turn is over; the same question asked again takes an answer', async () => {
    let status: SessionStatus = 'working'
    const { asks, writes, asksChanged } = setup({ status: () => status })
    const one = {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [{ question: 'Colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }]
      }
    }
    asks.onAsk(MANAGED, one)
    expect(asksChanged).toEqual([MANAGED])
    expect(await asks.answerSession(MANAGED, 'Purple')).toBeUndefined()
    expect(writes.map((w) => w.data)).toEqual([...TO_THE_EMPTIED_FIELD_OF_TWO, 'Purple', '\r'])
    expect(writes.at(-1)!.at - writes.at(-2)!.at).toBeGreaterThanOrEqual(290)

    asks.onAsk(MANAGED, one)
    status = 'approval'
    expect(await asks.answerSession(MANAGED, '2')).toBeUndefined()
    expect(writes.at(-1)?.data).toBe('2')

    asks.onAsk(MANAGED, one)
    status = 'waiting'
    expect(await asks.answerSession(MANAGED, '2')).toBe(SHOWS_NO_DIALOG)
    status = 'working'

    asks.onAsk(MANAGED, BASH)
    expect(await asks.answerSession(MANAGED, 'maybe later')).toBe('Reply yes or no.')
    asks.toolDone(MANAGED, { name: 'Bash', input: BASH.tool_input })
    expect(await asks.answerSession(MANAGED, 'yes')).toBe(SHOWS_NO_DIALOG)
  })

  // CC§12 CC§14
  it('the keys of a Claude answer stop the moment its dialog closes, so the rest of the run never lands in the prompt box, and the answer is reported as not taken; the same dialog delivered again meanwhile does not stop them', async () => {
    const { asks, writes } = setup({ status: () => 'approval' })
    asks.onAsk(MANAGED, QUESTION)
    const typing = asks.answerSession(MANAGED, '2')
    await vi.waitFor(() => expect(writes.length).toBe(1))
    asks.onAsk(MANAGED, QUESTION)
    expect(await asks.answerSession(MANAGED, '1')).toBe(ANSWER_ON_ITS_WAY)
    await vi.waitFor(() => expect(writes.length).toBe(2))
    asks.dialogGone(MANAGED, true)
    expect(await typing).toBe(SHOWS_NO_DIALOG)
    expect(writes.map((w) => w.data)).toEqual(TO_THE_EMPTIED_FIELD_OF_TWO.slice(0, 2))
  })

  // CC§14
  it('a Claude dialog of several questions that Koloft already typed into is walked back to question 1 before the next answer, though the owner never touched it', async () => {
    vi.useFakeTimers()
    try {
      const question = (q: string): object => ({
        question: q,
        options: [{ label: 'A' }, { label: 'B' }]
      })
      const two = {
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [question('One?'), question('Two?')] }
      }
      const { asks, writes, session } = setup({ status: () => 'approval' })
      session.takesKeys = false
      asks.onAsk(MANAGED, two)
      const first = asks.answerSession(MANAGED, '1\n1')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await first).toBe(ANSWER_NOT_TAKEN)
      const firstRun = writes.map((w) => w.data)
      expect(firstRun).not.toContain('\x1b[Z')
      const second = asks.answerSession(MANAGED, '2\n2')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await second).toBe(ANSWER_NOT_TAKEN)
      expect(writes.slice(firstRun.length).map((w) => w.data)).toContain('\x1b[Z')
    } finally {
      vi.useRealTimers()
    }
  })

  // CC§14
  it('the keys of a Claude answer stop when the owner presses a key at the Mac meanwhile; Koloft says it left the dialog to the owner and withdraws the reply it had recorded', async () => {
    let pressed = false
    const { asks, writes, answered } = setup({
      status: () => 'approval',
      ownerTouchedSince: () => pressed
    })
    asks.onAsk(MANAGED, QUESTION)
    const typing = asks.answerSession(MANAGED, '2')
    await vi.waitFor(() => expect(writes.length).toBe(1))
    pressed = true
    expect(await typing).toBe(STARTED_IN_THE_TERMINAL)
    expect(writes).toHaveLength(1)
    expect(answered.at(-1)).toEqual({ tab: MANAGED, reply: '' })
  })

  // CODEX§20 AGY§14
  it('a Codex or Antigravity question the owner already pressed keys in is left to the owner: Koloft presses nothing and says so', async () => {
    const question: CodexQuestion = {
      id: 0,
      questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Green' }] }]
    }
    for (const backend of ['codex', 'agy'] as const) {
      const { asks, writes } = setup({
        backendOf: () => backend,
        pendingQuestion: () => question,
        touchedSinceAsked: () => true
      })
      expect(await asks.answerSession(MANAGED, '2')).toBe(STARTED_IN_THE_TERMINAL)
      expect(writes).toEqual([])
    }
  })

  // CODEX§20
  it('a Codex answer stops pressing keys the moment the owner presses one in the question, says it left the question to the owner, and withdraws the reply it had recorded', async () => {
    let touched = false
    const question: CodexQuestion = {
      id: 0,
      questions: [
        {
          question: 'Which colour?',
          options: [{ label: 'Red' }, { label: 'Green' }],
          ownWords: true
        }
      ]
    }
    const { asks, writes, answered } = setup({
      backendOf: () => 'codex',
      pendingQuestion: () => question,
      touchedSinceAsked: () => touched
    })
    const typing = asks.answerSession(MANAGED, 'Purple')
    await vi.waitFor(() => expect(writes.length).toBe(1))
    touched = true
    expect(await typing).toBe(STARTED_IN_THE_TERMINAL)
    expect(writes.map((w) => w.data)).toEqual(['\x1b[B'])
    expect(answered.at(-1)).toEqual({ tab: MANAGED, reply: '' })
  })

  // CC§14
  it('a Claude dialog with a many-pick question the owner already pressed keys in is left to the owner, since Koloft’s digits would flip the ticks there; one with single picks is still answered', async () => {
    const fruit = {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Which fruits?',
            options: [{ label: 'Apple' }, { label: 'Banana' }],
            multiSelect: true
          }
        ]
      }
    }
    let pressedAt = 0
    const { asks, writes } = setup({
      status: () => 'approval',
      ownerTouchedSince: (_t, at) => pressedAt >= at
    })
    asks.onAsk(MANAGED, fruit)
    pressedAt = Date.now()
    expect(await asks.answerSession(MANAGED, 'Apple')).toBe(STARTED_IN_THE_TERMINAL)
    expect(writes).toEqual([])
    await new Promise((r) => setTimeout(r, 5))
    asks.onAsk(MANAGED, QUESTION)
    expect(await asks.answerSession(MANAGED, '2')).toBeUndefined()
    expect(writes.at(-1)?.data).toBe('2')
  })

  // CC§12 CC§14
  it('a Claude dialog answered by keys stays open until the session shows it closed, a second answer meanwhile is told to wait, and the first is told it was not taken if it never closes; a yes whose closing Koloft cannot see counts once typed, a no waits', async () => {
    vi.useFakeTimers()
    try {
      let closingShows = true
      const { asks, writes, session } = setup({
        status: () => 'approval',
        showsDialogsClosing: () => closingShows
      })
      session.takesKeys = false
      asks.onAsk(MANAGED, BASH)
      const first = asks.answerSession(MANAGED, 'yes')
      await vi.advanceTimersByTimeAsync(0)
      expect(asks.dialog(MANAGED)?.text).toContain('rm -rf build')
      expect(await asks.answerSession(MANAGED, 'yes')).toBe(ANSWER_ON_ITS_WAY)
      expect(writes.map((w) => w.data)).toEqual(['1'])

      await vi.advanceTimersByTimeAsync(A_TAKEN_ANSWER_SHOWS_WITHIN_MS)
      expect(await first).toBe(ANSWER_NOT_TAKEN)
      const again = asks.answerSession(MANAGED, 'yes')
      await vi.advanceTimersByTimeAsync(0)
      asks.dialogGone(MANAGED, false)
      expect(await again).toBeUndefined()
      expect(asks.dialog(MANAGED)).toBeUndefined()

      closingShows = false
      asks.onAsk(MANAGED, BASH)
      expect(await asks.answerSession(MANAGED, 'yes')).toBeUndefined()
      expect(asks.dialog(MANAGED)).toBeUndefined()
      asks.onAsk(MANAGED, BASH)
      const no = asks.answerSession(MANAGED, 'no')
      await vi.advanceTimersByTimeAsync(0)
      expect(asks.dialog(MANAGED)).toBeDefined()
      asks.dialogGone(MANAGED, false)
      expect(await no).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  // CODEX§3 CODEX§20
  it('a Codex approval is pressed y or Esc only while it is open; a one-question list is pressed the digit of the option named by number or label; any other question is refused as not probed, saying the butler can press its keys unless the butler is the one answering', async () => {
    let approval: { id: number } | undefined
    let question: CodexQuestion | undefined
    let input = false
    const { asks, writes } = setup({
      backendOf: () => 'codex',
      pendingApproval: () => approval,
      pendingQuestion: () => question,
      awaitsInput: () => input
    })
    expect(await asks.answerSession(MANAGED, 'yes')).toBe(SHOWS_NO_DIALOG)
    input = true
    expect(await asks.answerSession(MANAGED, 'yes')).toBe(inputNotProbed('Codex'))
    expect(inputNotProbed('Codex')).toContain('The butler can still answer')
    expect(await asks.answerSession(MANAGED, 'yes', { byTheOverseer: true })).toBe(
      'Codex is asking something Koloft cannot answer from here: it answers a yes-or-no approval, or questions that each pick an option from a list.'
    )
    question = {
      id: 0,
      questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Green' }] }]
    }
    expect(await asks.answerSession(MANAGED, '3')).toContain('one option')
    expect(await asks.answerSession(MANAGED, 'blue')).toContain('one option')
    expect(await asks.answerSession(MANAGED, '2')).toBeUndefined()
    expect(await asks.answerSession(MANAGED, ' green ')).toBeUndefined()
    approval = { id: 7 }
    expect(await asks.answerSession(MANAGED, '2')).toContain('yes or no')
    expect(await asks.answerSession(MANAGED, 'yes')).toBeUndefined()
    expect(await asks.answerSession(MANAGED, 'no')).toBeUndefined()
    expect(writes.map((w) => w.data)).toEqual(['2', '2', 'y', '\x1b'])
  })

  // CODEX§20
  it('a Codex dialog of several questions takes one line per question, each pressed as its digit or as a note under "None of the above"; a reply of any other line count is refused and presses nothing', async () => {
    const colours = [{ label: 'Red' }, { label: 'Green' }]
    const question: CodexQuestion = {
      id: 0,
      questions: [
        { question: 'Which colour?', options: colours, ownWords: true },
        { question: 'Which size?', options: [{ label: 'Small' }, { label: 'Large' }] }
      ]
    }
    const { asks, writes } = setup({
      backendOf: () => 'codex',
      pendingQuestion: () => question
    })
    expect(await asks.answerSession(MANAGED, 'Purple')).toBe(ONE_LINE_PER_QUESTION)
    expect(await asks.answerSession(MANAGED, 'Purple\nHuge')).toBe(ONE_LINE_PER_QUESTION)
    expect(writes).toEqual([])
    expect(await asks.answerSession(MANAGED, 'Purple\nlarge')).toBeUndefined()
    expect(writes.map((w) => w.data)).toEqual(['\x1b[B', '\x1b[B', '\t', 'Purple', '\r', '2'])
  })

  // AGY§14
  it('an Antigravity question that takes several picks takes their numbers or names split by commas, gets no buttons, and is pressed as each digit then Enter; own words go in as for one pick; a whole line naming one option counts though the name holds a comma, and more or fewer picks than the question takes are refused with its limits', async () => {
    const fruits = {
      question: 'Which fruits?',
      options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
      ownWords: true as const,
      multiSelect: true as const
    }
    const colour = {
      question: 'Which colour?',
      options: [{ label: 'Red' }, { label: 'Blue' }],
      ownWords: true as const
    }
    let question: CodexQuestion = { id: 'hook:1', questions: [fruits] }
    const { asks, writes } = setup({
      backendOf: () => 'agy',
      pendingQuestion: () => question
    })
    const pressed = async (reply: string): Promise<string[]> => {
      writes.length = 0
      expect(await asks.answerSession(MANAGED, reply)).toBeUndefined()
      return writes.map((w) => w.data)
    }
    expect(codexDialog(question, 'Antigravity').choices).toEqual([])
    expect(await pressed('cherry, 1')).toEqual(['1', '3', '\r'])
    expect(await pressed('A ripe mango')).toEqual(['4', 'A ripe mango', '\r'])
    question = { id: 'hook:2', questions: [fruits, colour] }
    expect(await asks.answerSession(MANAGED, '1, 3')).toBe(
      'Reply with one line per question: a number (or several, split by commas, where it takes more than one) or your own answer.'
    )
    expect(await pressed('1, 3\n2')).toEqual(['1', '3', '\r', '2'])

    question = { id: 'hook:3', questions: [{ ...fruits, fewest: 2, most: 2 }] }
    expect(await asks.answerSession(MANAGED, '1')).toBe(
      'Reply with the numbers of the options you pick, split by commas, or your own answer. “Which fruits?” takes 2 to 2 picks.'
    )
    expect(await asks.answerSession(MANAGED, '1, 2, 3')).toContain('takes 2 to 2 picks')
    question = {
      id: 'hook:4',
      questions: [{ ...fruits, options: [{ label: 'Red, dark' }, { label: 'Blue' }] }]
    }
    expect(await pressed('red, dark')).toEqual(['1', '\r'])
  })
})

describe('SessionAsks: an answer typed as keys counts only once the session shows it took it', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const COLOUR: CodexQuestion = {
    id: 'q1',
    questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Green' }] }]
  }

  function codexAsking(more: Partial<SessionAskDeps> = {}, approval?: { id: number }) {
    const s = setup({
      backendOf: () => 'codex',
      pendingApproval: () => approval,
      pendingQuestion: () => (approval ? undefined : COLOUR),
      ...more
    })
    s.session.takesKeys = false
    return s
  }

  for (const [what, approval, reply] of [
    ['a question', undefined, '2'],
    ['an approval', { id: 7 }, 'yes']
  ] as const)
    it(`keys the session ignores for ${what} are reported as not taken`, async () => {
      const { asks, writes } = codexAsking({}, approval)
      const answered = asks.answerSession(TAB, reply)
      await vi.advanceTimersByTimeAsync(A_TAKEN_ANSWER_SHOWS_WITHIN_MS)
      expect(writes).not.toEqual([])
      expect(await answered).toBe(ANSWER_NOT_TAKEN)
    })

  it('an answer that shows up late, but in time, counts as answered', async () => {
    const { asks } = codexAsking()
    const answered = asks.answerSession(TAB, '2')
    await vi.advanceTimersByTimeAsync(10_000)
    asks.dialogGone(TAB, false)
    expect(await answered).toBeUndefined()
  })

  for (const backend of ['codex', 'agy'] as const)
    for (const [what, approval] of [
      ['question', undefined],
      ['approval', { id: 7 }]
    ] as const)
      it(`a second answer to one ${backend} ${what} while the first one's keys go in, or wait to be seen taken, is told to wait and reaches the session by no route, though the dialog's id changed meanwhile; once the first is not taken, a new answer goes in`, async () => {
        let id = 'hook:1'
        let viaApi = false
        let inPlaceTries = 0
        const { asks, writes } = codexAsking(
          {
            backendOf: () => backend,
            pendingQuestion: () => (approval ? undefined : { ...COLOUR, id }),
            answerInPlace: async () => (++inPlaceTries, viaApi && {})
          },
          approval
        )
        const first = asks.answerSession(TAB, approval ? 'yes' : '1')
        await vi.advanceTimersByTimeAsync(0)
        expect(writes.length).toBeGreaterThan(0)
        id = 'traj:4'
        viaApi = true
        expect(await asks.answerSession(TAB, approval ? 'no' : '2')).toBe(ANSWER_ON_ITS_WAY)
        await vi.advanceTimersByTimeAsync(A_TAKEN_ANSWER_SHOWS_WITHIN_MS / 2)
        expect(await asks.answerSession(TAB, approval ? 'no' : '2')).toBe(ANSWER_ON_ITS_WAY)
        const firstKeys = approval ? ['y'] : ['1']
        expect(writes.map((w) => w.data)).toEqual(firstKeys)
        expect(inPlaceTries).toBe(1)
        await vi.advanceTimersByTimeAsync(A_TAKEN_ANSWER_SHOWS_WITHIN_MS)
        expect(await first).toBe(ANSWER_NOT_TAKEN)
        expect(await asks.answerSession(TAB, approval ? 'yes' : '1')).toBeUndefined()
        expect(inPlaceTries).toBe(2)
      })

  // AGY§14
  const FRUITS_TAKING_SEVERAL = {
    question: 'Which fruits?',
    options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
    multiSelect: true as const
  }

  it("an Antigravity question that takes several picks, whose ticks Koloft pressed but the session did not take, is left to the owner: a later answer presses nothing, so it cannot untick them, though the dialog's id changed meanwhile; another several-pick question, and the same one asked again once its dialog is gone, are answered as usual", async () => {
    const several = (question: string, id: string): CodexQuestion => ({
      id,
      questions: [{ ...FRUITS_TAKING_SEVERAL, question }]
    })
    let asked = several('Which fruits?', 'hook:1')
    const { asks, writes, session } = codexAsking({
      backendOf: () => 'agy',
      pendingQuestion: () => asked
    })
    const answering = asks.answerSession(TAB, '1, 3')
    await vi.advanceTimersByTimeAsync(0)
    expect(await asks.answerSession(TAB, '2')).toBe(ANSWER_ON_ITS_WAY)
    await vi.advanceTimersByTimeAsync(A_TAKEN_ANSWER_SHOWS_WITHIN_MS * 2)
    expect(await answering).toBe(ANSWER_NOT_TAKEN)
    const pressedOnce = writes.length
    expect(pressedOnce).toBeGreaterThan(0)

    asked = several('Which fruits?', 'traj:4')
    expect(await asks.answerSession(TAB, '1, 3')).toBe(PICKS_MAY_STILL_BE_TICKED)
    expect(await asks.answerSession(TAB, '2')).toBe(PICKS_MAY_STILL_BE_TICKED)
    expect(writes).toHaveLength(pressedOnce)

    session.takesKeys = true
    const taken = async (): Promise<string | undefined> => {
      const answered = asks.answerSession(TAB, '2')
      await vi.advanceTimersByTimeAsync(A_TAKEN_ANSWER_SHOWS_WITHIN_MS)
      return answered
    }
    asked = several('Which pies?', 'hook:2')
    expect(await taken()).toBeUndefined()
    const pressedTwice = writes.length
    expect(pressedTwice).toBeGreaterThan(pressedOnce)

    asked = several('Which fruits?', 'hook:3')
    expect(await taken()).toBeUndefined()
    expect(writes.length).toBeGreaterThan(pressedTwice)
  })

  it('an answer waiting on a tab that closes is reported at once, not after the whole wait', async () => {
    const { asks } = codexAsking()
    const answered = asks.answerSession(TAB, '2')
    await vi.advanceTimersByTimeAsync(0)
    asks.forget(TAB)
    expect(await answered).toBe(ANSWER_NOT_TAKEN)
  })

  it('an answer the session took in place, not as keys, counts at once', async () => {
    const { asks, writes } = codexAsking({ answerInPlace: async () => ({}) })
    expect(await asks.answerSession(TAB, '2')).toBeUndefined()
    expect(writes).toEqual([])
  })

  it('the wait starts once every key is typed, so an answer slow to go in that the session takes is not called ignored', async () => {
    const typing = A_TAKEN_ANSWER_SHOWS_WITHIN_MS + 1000
    const { asks } = codexAsking({
      answerable: () => new Promise((r) => setTimeout(r, typing))
    })
    const answered = asks.answerSession(TAB, '2')
    await vi.advanceTimersByTimeAsync(typing + 1000)
    asks.dialogGone(TAB, false)
    expect(await answered).toBeUndefined()
  })

  it('an answer the session takes while its keys are still going in counts as answered', async () => {
    const several: CodexQuestion = {
      id: 'q2',
      questions: [COLOUR.questions[0], COLOUR.questions[0]]
    }
    const { asks, writes } = codexAsking({ pendingQuestion: () => several })
    const answered = asks.answerSession(TAB, '2\n1')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toHaveLength(1)
    asks.dialogGone(TAB, false)
    await vi.advanceTimersByTimeAsync(A_TAKEN_ANSWER_SHOWS_WITHIN_MS * 2)
    expect(await answered).toBeUndefined()
    expect(writes.length).toBeGreaterThan(1)
  })
})
