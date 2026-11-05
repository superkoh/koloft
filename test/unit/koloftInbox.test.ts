import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AttentionEvent } from '../../src/shared/types'
import { Inbox, type InboxHost } from '../../src/main/inbox'
import {
  KoloftInbox,
  replyFor,
  type KoloftAsk,
  type KoloftInboxDeps
} from '../../src/main/koloftInbox'
import { inboxVerb } from '../../src/main/agentInbox'
import { SHOWS_NO_DIALOG } from '../../src/main/discord/relay'
import type { AgentCaller } from '../../src/main/agentRequests'

function host(): InboxHost {
  return {
    now: () => Date.now(),
    sendToSession: async (session) => ({ ok: true, session }),
    answerSession: async () => ({ ok: true }),
    startSession: async () => ({ ok: true, session: 'new' }),
    footer: () => '',
    changed: () => {}
  }
}

const twoQuestions: KoloftAsk = {
  kind: 'question',
  questions: [
    { question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] },
    {
      question: 'Which sizes?',
      multiSelect: true,
      options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }]
    }
  ]
}

function world(over: Partial<KoloftInboxDeps> = {}) {
  const inbox = new Inbox(host())
  let marks: AttentionEvent[] = []
  const answered: [string, string][] = []
  const deps: KoloftInboxDeps = {
    inbox,
    marks: () => marks,
    sessionOfTab: (tabId) => ({
      sessionId: `s-${tabId}`,
      tabId,
      title: 'Fix login',
      backend: 'claude',
      workspace: 'koloft'
    }),
    liveTabOf: (ref) => ({ tabId: ref.replace(/^s-/, ''), backend: 'claude' }),
    askOf: async () => twoQuestions,
    answer: async (tabId, reply) => {
      answered.push([tabId, reply])
      return undefined
    },
    butlerSide: () => false,
    watching: () => null,
    ...over
  }
  const koloft = new KoloftInbox(deps)
  return {
    inbox,
    koloft,
    answered,
    mark: (m: AttentionEvent[]) => {
      marks = m
      koloft.sync()
    }
  }
}

const asking: AttentionEvent = { tabId: 't1', kind: 'approval', at: 100, sessionId: 's-t1' }

describe('Koloft source — a session waiting on the owner is a card, and the card follows the session', () => {
  it('a session that asks gets a high card with every question on it', async () => {
    const w = world()
    w.mark([asking])
    await vi.waitFor(() => expect(w.inbox.all()).toHaveLength(1))
    const card = w.inbox.all()[0]
    expect(card).toMatchObject({ level: 'high', state: 'needs-you', session: 's-t1' })
    expect(card.blocks[0]).toMatchObject({ type: 'choice' })
  })

  it('answered in its tab, the card closes on its own', async () => {
    const w = world()
    w.mark([asking])
    await vi.waitFor(() => expect(w.inbox.all()).toHaveLength(1))
    w.mark([])
    expect(w.inbox.all()[0]).toMatchObject({ state: 'closed', status: 'Handled in its tab' })
  })

  const finished = (tabId: string): AttentionEvent => ({
    tabId,
    kind: 'turn-done',
    at: 7,
    sessionId: `s-${tabId}`
  })

  it('a turn judged as needing the owner gets a card with that turn’s reply and a reply box, only once the verdict is in', () => {
    const w = world()
    w.mark([finished('t1')])
    w.koloft.turnEnded('t1', 'Done. Shall I merge it?', false)
    expect(w.inbox.all()).toEqual([])
    w.koloft.judged('t1', false)
    expect(w.inbox.all()[0]).toMatchObject({
      title: '“Fix login” finished and waits for you',
      blocks: [
        { type: 'quote', text: 'Done. Shall I merge it?' },
        { type: 'input', id: 'reply' }
      ]
    })
  })

  it('a finished turn gets no card when it is only news, its reply went to another session, it is the butler’s, or the owner is watching it', () => {
    const w = world({ butlerSide: (tabId) => tabId === 't3', watching: () => 't4' })
    w.mark(['t1', 't2', 't3', 't4'].map(finished))
    w.koloft.turnEnded('t1', 'All done.', false)
    w.koloft.judged('t1', true)
    w.koloft.turnEnded('t2', 'Here is what you asked for.', true)
    w.koloft.judged('t2', false)
    w.koloft.turnEnded('t3', 'Hello from the butler.', false)
    w.koloft.judged('t3', false)
    w.koloft.turnEnded('t4', 'Which one?', false)
    w.koloft.judged('t4', false)
    expect(w.inbox.all()).toEqual([])
  })

  it('a question from the butler or its helpers gets a card too', async () => {
    const w = world({ butlerSide: () => true })
    w.mark([asking])
    await vi.waitFor(() => expect(w.inbox.all()).toHaveLength(1))
  })

  it('a finished-turn card closes once the session works again', () => {
    const w = world()
    w.mark([finished('t1')])
    w.koloft.turnEnded('t1', 'Which branch?', false)
    w.koloft.judged('t1', false)
    w.mark([])
    expect(w.inbox.all()[0]).toMatchObject({ state: 'closed', status: 'It went on' })
  })

  it('a session that stopped unexpectedly gets a card to start it again', async () => {
    const w = world()
    w.mark([{ tabId: 't1', kind: 'exited', at: 5, sessionId: 's-t1' }])
    await vi.waitFor(() => expect(w.inbox.all()).toHaveLength(1))
    expect(w.inbox.all()[0].actions.map((a) => a.id)).toEqual(['restart', 'handoff', 'close'])
  })

  it('answers to several questions reach the session one line each, as option numbers', () => {
    const qs = [
      {
        id: 'q0',
        text: 'a',
        multi: false,
        ownAnswer: true,
        options: [
          { id: 'o0', label: 'x' },
          { id: 'o1', label: 'y' }
        ]
      },
      {
        id: 'q1',
        text: 'b',
        multi: true,
        ownAnswer: false,
        options: [
          { id: 'o0', label: 'S' },
          { id: 'o1', label: 'M' },
          { id: 'o2', label: 'L' }
        ]
      }
    ]
    expect(replyFor(qs, { q0: ['o1'], q1: ['o0', 'o2'] })).toBe('2\n1, 3')
    expect(replyFor(qs, { q0: { own: 'neither' }, q1: ['o1'] })).toBe('neither\n2')
    expect(replyFor(qs, { q0: ['o0'] })).toBeUndefined()
  })

  it('an answer for a session no longer asking ends as done elsewhere, and nothing is typed', async () => {
    const w = world()
    expect(await w.koloft.answer('s-t1', { pick: 'yes' })).toMatchObject({ elsewhere: true })
    expect(w.answered).toEqual([])
  })

  it('an answer the session no longer shows a dialog for ends as done elsewhere', async () => {
    const w = world({ answer: async () => SHOWS_NO_DIALOG })
    w.mark([asking])
    expect(await w.koloft.answer('s-t1', { pick: 'yes' })).toMatchObject({ elsewhere: true })
  })

  it('an answer is built from what the session asks right now', async () => {
    const w = world()
    w.mark([asking])
    await w.koloft.answer('s-t1', { answers: { q0: ['o1'], q1: ['o2'] } })
    expect(w.answered).toEqual([['t1', '2\n3']])
  })
})

describe('koloft inbox — a session posts and moves its own cards', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const caller = (sessionId: string, tabId = 'tab-1'): AgentCaller =>
    ({ tabId, cwd: '/w', session: { sessionId } }) as unknown as AgentCaller

  function verb() {
    const inbox = new Inbox(host())
    const koloft = new KoloftInbox({
      inbox,
      marks: () => [],
      sessionOfTab: () => undefined,
      liveTabOf: () => undefined,
      askOf: async () => undefined,
      answer: async () => undefined,
      butlerSide: () => false,
      watching: () => null
    })
    const run = inboxVerb({ inbox: () => inbox, whereOf: () => ({ workspace: 'koloft' }) })
    return { inbox, koloft, run }
  }

  const card = JSON.stringify({ title: 'Pull request 8 is ready', level: 'normal' })

  it('a card a session posts is about that session and shows where it runs', async () => {
    const { inbox, run } = verb()
    await run(['add', 'pr-8', '--', card], caller('s1'))
    expect(inbox.all()[0]).toMatchObject({
      session: 's1',
      postedBy: 's1',
      where: { workspace: 'koloft' }
    })
  })

  it('another session cannot move it', async () => {
    const { run } = verb()
    await run(['add', 'pr-8', '--', card], caller('s1'))
    const out = await run(['move', 'pr-8', 'closed'], caller('s2', 'tab-2'))
    expect(out.exit).not.toBe(0)
  })

  it('a card posted before the session has its id stays its own once the id comes', async () => {
    const { inbox, koloft, run } = verb()
    await run(['add', 'pr-8', '--', card], caller('', 'tab-1'))
    koloft.rebound('tab-1', 's1')
    await run(['move', 'pr-8', 'closed', '--', 'Merged'], caller('s1'))
    expect(inbox.all()[0]).toMatchObject({ state: 'closed', status: 'Merged', session: 's1' })
  })
})
