import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Inbox, type InboxHost } from '../../src/main/inbox'
import {
  DONE_KEPT_MS,
  UNDO_MS,
  cardsIn,
  fillTemplate,
  inboxCounts,
  pickToPress,
  type InboxCardInput
} from '../../src/shared/inbox'

function makeHost(
  over: Partial<InboxHost> = {}
): InboxHost & { sent: [string, string, boolean][]; answered: [string, unknown][] } {
  const sent: [string, string, boolean][] = []
  const answered: [string, unknown][] = []
  return {
    sent,
    answered,
    now: () => Date.now(),
    sendToSession: async (session, text, toItsOwnSession) => {
      sent.push([session, text, toItsOwnSession])
      return { ok: true, session }
    },
    answerSession: async (session, answer) => {
      answered.push([session, answer])
      return { ok: true }
    },
    startSession: async () => ({ ok: true, session: 's-new', name: 'New one' }),
    footer: () => 'footer',
    changed: () => {},
    ...over
  }
}

const question: InboxCardInput = {
  key: 'ask-1',
  title: 'It asks',
  level: 'high',
  session: 's1',
  blocks: [
    {
      type: 'choice',
      id: 'q',
      questions: [
        {
          id: 'fmt',
          text: 'Which?',
          multi: false,
          ownAnswer: true,
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' }
          ]
        }
      ]
    }
  ],
  actions: [
    {
      id: 'answer',
      label: 'Answer',
      takes: ['q'],
      run: { type: 'session', session: 'card', answer: 'q' },
      then: {
        done: { state: 'closed', status: 'Answered' },
        elsewhere: { state: 'closed', status: 'Handled in its tab' }
      }
    }
  ]
}

const done: InboxCardInput = {
  key: 'done-1',
  title: 'It is done',
  level: 'normal',
  session: 's1',
  blocks: [{ type: 'input', id: 'next', required: true }],
  actions: [
    {
      id: 'close',
      label: 'Close',
      style: 'danger',
      confirm: 'Closes it',
      run: { type: 'session', session: 'card', message: 'close yourself' },
      then: { done: { state: 'in-progress', status: 'Closing it' } }
    },
    {
      id: 'next',
      label: 'Send',
      takes: ['next'],
      run: { type: 'session', session: 'card', message: '{answer:next}' },
      then: { done: { state: 'in-progress' } },
      lets: ['needs-you', 'closed']
    }
  ]
}

describe('inbox — cards belong to the source that posted them', () => {
  it('posting the same key again replaces that card instead of adding one', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    inbox.add({ source: 'koloft' }, question)
    inbox.add({ source: 'koloft' }, { ...question, title: 'It asks again' })
    expect(inbox.all()).toHaveLength(1)
    expect(inbox.all()[0].title).toBe('It asks again')
  })

  it('a session can change only the cards it posted', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    inbox.add({ source: 'koloft', as: 's1' }, done)
    expect(() =>
      inbox.update({ source: 'koloft', as: 's2' }, 'done-1', { title: 'mine now' })
    ).toThrow(/no card/)
    expect(() => inbox.move({ source: 'koloft', as: 's2' }, 'done-1', 'closed')).toThrow(/no card/)
  })

  it('a session cannot see, change or delete the cards the source’s own code posted', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    inbox.add({ source: 'koloft' }, question)
    expect(inbox.list({ source: 'koloft', as: 's2' })).toEqual([])
    expect(() => inbox.delete({ source: 'koloft', as: 's2' }, 'ask-1')).toThrow(/no card/)
    expect(inbox.all()[0].state).toBe('needs-you')
  })

  it('two sessions may use the same key, each for its own card', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    inbox.add({ source: 'koloft', as: 's1' }, done)
    inbox.add({ source: 'koloft', as: 's2' }, { ...done, title: 'Theirs' })
    expect(inbox.all().map((c) => [c.postedBy, c.title])).toEqual([
      ['s1', 'It is done'],
      ['s2', 'Theirs']
    ])
  })

  it('posting a key again after its card closed makes a fresh card', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    inbox.add({ source: 'koloft', as: 's1' }, done)
    inbox.move({ source: 'koloft', as: 's1' }, 'done-1', 'closed')
    inbox.add({ source: 'koloft', as: 's1' }, done)
    expect(inbox.all().map((c) => c.state)).toEqual(['needs-you'])
  })

  it('a card closed more than 7 days ago is dropped', () => {
    let now = 1_000
    const inbox = new Inbox(makeHost({ now: () => now }))
    inbox.register({ id: 'koloft', name: 'Koloft' })
    inbox.add({ source: 'koloft', as: 's1' }, done)
    inbox.move({ source: 'koloft', as: 's1' }, 'done-1', 'closed')
    now += DONE_KEPT_MS + 1
    inbox.add({ source: 'koloft', as: 's1' }, { ...done, key: 'other' })
    expect(inbox.all().map((c) => c.key)).toEqual(['other'])
  })

  it('a template puts the owner’s words in as they are, $ signs too', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    inbox.add({ source: 'koloft', as: 's1' }, { ...done, title: 'costs $& {answer:next}' })
    expect(fillTemplate('{title} / {answer:next}', inbox.all()[0], { next: "it's $' less" })).toBe(
      "costs $& {answer:next} / «it's $' less»"
    )
  })

  it('a card from an unregistered source is refused', () => {
    const inbox = new Inbox(makeHost())
    expect(() => inbox.add({ source: 'github' }, question)).toThrow(/not registered/)
  })

  it('a button that answers a question must say where the card goes when it was answered elsewhere', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const bad = {
      ...question,
      actions: [{ ...question.actions![0], then: { done: { state: 'closed' as const } } }]
    }
    expect(() => inbox.add({ source: 'koloft' }, bad)).toThrow(/then.elsewhere/)
  })

  it('a source that unregisters closes its open cards as gone', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    inbox.add({ source: 'koloft' }, question)
    inbox.unregister('koloft')
    expect(inbox.all()[0]).toMatchObject({
      state: 'closed',
      status: 'Source is gone',
      closedBy: 'inbox'
    })
  })
})

describe('inbox — a press waits 5 seconds, then goes to the session', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('an undo within 5 seconds sends nothing', async () => {
    const host = makeHost()
    const inbox = new Inbox(host)
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const { id } = inbox.add({ source: 'koloft' }, question)
    inbox.press(id, 'answer', { q: { fmt: ['a'] } })
    inbox.undo(id)
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10)
    expect(host.answered).toEqual([])
    expect(inbox.all()[0].press).toBeNull()
  })

  it('after 5 seconds the answer reaches the session and the card moves where the button said', async () => {
    const host = makeHost()
    const inbox = new Inbox(host)
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const { id } = inbox.add({ source: 'koloft' }, question)
    inbox.press(id, 'answer', { q: { fmt: ['b'] } })
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10)
    expect(host.answered).toEqual([['s1', { answers: { fmt: ['b'] } }]])
    expect(inbox.all()[0]).toMatchObject({ state: 'closed', status: 'Answered' })
  })

  it('a question already answered in its tab ends as done elsewhere', async () => {
    const inbox = new Inbox(
      makeHost({ answerSession: async () => ({ ok: false, elsewhere: true }) })
    )
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const { id } = inbox.add({ source: 'koloft' }, question)
    inbox.press(id, 'answer', { q: { fmt: ['a'] } })
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10)
    expect(inbox.all()[0]).toMatchObject({ state: 'closed', status: 'Handled in its tab' })
    expect(inbox.all()[0].note).toMatchObject({ outcome: 'elsewhere' })
  })

  it('an answer that failed keeps the card waiting with try again, unless the source says trying again cannot help', async () => {
    for (const retryHelps of [undefined, false]) {
      const inbox = new Inbox(
        makeHost({ answerSession: async () => ({ ok: false, why: 'not taken', retryHelps }) })
      )
      inbox.register({ id: 'koloft', name: 'Koloft' })
      const { id } = inbox.add({ source: 'koloft' }, question)
      inbox.press(id, 'answer', { q: { fmt: ['a'] } })
      await vi.advanceTimersByTimeAsync(UNDO_MS + 10)
      expect(inbox.all()[0]).toMatchObject({
        state: 'needs-you',
        note: { outcome: 'failed', text: 'not taken', retry: retryHelps !== false }
      })
    }
  })

  it('the source changing the card during the 5 seconds drops the press', async () => {
    const host = makeHost()
    const inbox = new Inbox(host)
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const { id } = inbox.add({ source: 'koloft' }, question)
    inbox.press(id, 'answer', { q: { fmt: ['a'] } })
    inbox.move({ source: 'koloft' }, 'ask-1', { state: 'closed', status: 'Handled in its tab' })
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10)
    expect(host.answered).toEqual([])
    expect(inbox.all()[0].note).toMatchObject({ kind: 'changed' })
  })

  it('a danger button asks first and waits only after the confirm', async () => {
    const host = makeHost()
    const inbox = new Inbox(host)
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const { id } = inbox.add({ source: 'koloft', as: 's1' }, done)
    inbox.press(id, 'close', {})
    expect(inbox.all()[0].press?.step).toBe('confirm')
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10)
    expect(host.sent).toEqual([])
    inbox.confirm(id)
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10)
    expect(host.sent[0][1]).toContain('close yourself')
    expect(inbox.all()[0]).toMatchObject({ state: 'in-progress', status: 'Closing it' })
  })

  it('a message wraps the owner’s own words in « » under a fixed first line, and the host writes its last line', async () => {
    const host = makeHost()
    const inbox = new Inbox(host)
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const { id } = inbox.add({ source: 'koloft', as: 's1' }, done)
    inbox.press(id, 'next', { next: 'commit it' })
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10)
    expect(host.sent[0][1].split('\n')).toEqual([
      '(From Inbox: the owner pressed “Send” on card done-1 of Koloft:)',
      '«commit it»',
      'footer'
    ])
  })

  it('a button’s message tells the host whether it goes to the card’s own session, since only there may it claim that session’s own permission class (ADR-0028)', async () => {
    const host = makeHost()
    const inbox = new Inbox(host)
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const toOther = {
      id: 'tell',
      label: 'Tell s2',
      run: { type: 'session' as const, session: 's2', message: 'go' }
    }
    const toSelf = {
      id: 'self',
      label: 'Tell s1',
      run: { type: 'session' as const, session: 's1', message: 'go' }
    }
    const { id } = inbox.add(
      { source: 'koloft', as: 's1' },
      { ...done, actions: [...done.actions!, toOther, toSelf] }
    )
    inbox.press(id, 'next', { next: 'go on' })
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10)
    inbox.press(id, 'tell', {})
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10)
    inbox.press(id, 'self', {})
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10)
    expect(host.sent.map(([to, , own]) => [to, own])).toEqual([
      ['s1', true],
      ['s2', false],
      ['s1', true]
    ])
  })

  it('a session a button hands the card to may then move it, only to the states the button lets', async () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const { id } = inbox.add({ source: 'koloft', as: 's9' }, done)
    inbox.press(id, 'next', { next: 'go on' })
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10)
    inbox.move({ source: 'koloft', as: 's1' }, 'done-1', { state: 'closed', status: 'Done' })
    expect(inbox.all()[0]).toMatchObject({ state: 'closed', status: 'Done' })
  })

  it('a press that was going when Koloft quit comes back as failed with try again', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const { id } = inbox.add({ source: 'koloft' }, question)
    inbox.press(id, 'answer', { q: { fmt: ['a'] } })
    const snap = inbox.snapshot()
    snap.cards[0].press = { ...snap.cards[0].press!, step: 'working' }
    const again = new Inbox(makeHost(), structuredClone(snap))
    expect(again.all()[0]).toMatchObject({ press: null, note: { outcome: 'failed', retry: true } })
    expect(again.isReady('koloft')).toBe(false)
  })

  it('a press still inside its 5 seconds when Koloft quit comes back as not sent, with try again', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const { id } = inbox.add({ source: 'koloft' }, question)
    inbox.press(id, 'answer', { q: { fmt: ['a'] } })
    const again = new Inbox(makeHost(), structuredClone(inbox.snapshot()))
    expect(again.all()[0]).toMatchObject({
      press: null,
      note: { outcome: 'failed', retry: true },
      lastPress: { action: 'answer' }
    })
  })

  it('a press that ends after the card was closed leaves it closed', async () => {
    let release = (): void => {}
    const host = makeHost({
      sendToSession: (session) => new Promise((r) => (release = () => r({ ok: true, session })))
    })
    const inbox = new Inbox(host)
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const { id } = inbox.add({ source: 'koloft', as: 's1' }, done)
    inbox.press(id, 'next', { next: 'go on' })
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10)
    inbox.move({ source: 'koloft', as: 's1' }, 'done-1', { state: 'closed', status: 'Merged' })
    release()
    await vi.advanceTimersByTimeAsync(10)
    expect(inbox.all()[0]).toMatchObject({ state: 'closed', status: 'Merged' })
  })
})

describe('inbox — the owner’s own controls', () => {
  it('dismiss closes the card without asking its source', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const { id } = inbox.add({ source: 'koloft' }, question)
    inbox.dismiss(id)
    expect(inbox.all()[0]).toMatchObject({ state: 'closed', status: 'Dismissed', closedBy: 'you' })
  })

  it('a level the owner set survives the source posting the card again', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    const { id } = inbox.add({ source: 'koloft' }, question)
    inbox.setYourLevel(id, 'low')
    inbox.add({ source: 'koloft' }, { ...question, level: 'high' })
    expect(inbox.all()[0].yourLevel).toBe('low')
  })

  it('the badge counts cards that need you, but not low ones', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    inbox.add({ source: 'koloft' }, question)
    inbox.add({ source: 'koloft' }, { ...question, key: 'fyi', level: 'low' })
    expect(inboxCounts(inbox.all(), Date.now())).toMatchObject({ badge: 1, high: 1 })
  })

  it('priority order puts high first, then the oldest', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    inbox.add({ source: 'koloft' }, { ...question, key: 'n', level: 'normal', happenedAt: 1 })
    inbox.add({ source: 'koloft' }, { ...question, key: 'h', level: 'high', happenedAt: 5 })
    inbox.add({ source: 'koloft' }, { ...question, key: 'h0', level: 'high', happenedAt: 2 })
    expect(cardsIn(inbox.all(), 'needs-you', {}, Date.now()).map((c) => c.key)).toEqual([
      'h0',
      'h',
      'n'
    ])
  })

  it('the only button of a card, taking one pick-one question, is pressed by picking an option', () => {
    const inbox = new Inbox(makeHost())
    inbox.register({ id: 'koloft', name: 'Koloft' })
    inbox.add({ source: 'koloft' }, question)
    expect(pickToPress(inbox.all()[0])?.action.id).toBe('answer')
  })
})
