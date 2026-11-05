import type { AttentionEvent, BackendId } from '@shared/types'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import {
  CARD_SESSION,
  type InboxAnswers,
  type InboxCard,
  type InboxCardInput,
  type InboxQuestion
} from '@shared/inbox'
import type { AskPayload } from '@shared/sessionEvent'
import type { AnswerResult, Inbox, InboxCaller } from './inbox'
import {
  planOf,
  questionsOf,
  type CodexApproval,
  type CodexQuestion,
  type Question
} from './discord/dialog'
import { SHOWS_NO_DIALOG } from './discord/relay'

export const KOLOFT_SOURCE = { id: 'koloft', name: 'Koloft' }
const KOLOFT: InboxCaller = { source: KOLOFT_SOURCE.id }
const DETAILS_RETRY_MS = 1500

export const CARRY_ON =
  'Koloft started you again after you stopped unexpectedly. Carry on where you left off.'
export const CLOSE_YOURSELF =
  'Wrap up and close this session: commit what is still open, then run koloft session close as your very last step. If Koloft refuses, say why and stop.'

export type KoloftAsk =
  | { kind: 'question'; questions: Question[] }
  | { kind: 'approval'; command?: string; plan?: string }

export interface AskedSession {
  sessionId: string
  title: string
  backend: BackendId
  workspace?: string
  machine?: string
}

export interface KoloftInboxDeps {
  inbox: Inbox
  marks(): AttentionEvent[]
  sessionOfTab(tabId: string): AskedSession | undefined
  liveTabOf(ref: string): { tabId: string; backend: BackendId } | undefined
  askOf(tabId: string): Promise<KoloftAsk | undefined>
  answer(tabId: string, reply: string): Promise<string | undefined>
  judging(tabId: string): boolean
  lastReply(sessionId: string): Promise<string | undefined>
}

export function askFromClaude(p: AskPayload): KoloftAsk {
  if (p.tool_name === 'AskUserQuestion') return { kind: 'question', questions: questionsOf(p) }
  const plan = planOf(p)
  if (plan !== undefined) return { kind: 'approval', plan }
  const command = p.tool_input?.command
  return {
    kind: 'approval',
    command:
      typeof command === 'string'
        ? command
        : `${p.tool_name ?? 'A tool'} ${JSON.stringify(p.tool_input ?? {})}`
  }
}

export function askFromCodex(a: CodexApproval | CodexQuestion): KoloftAsk {
  if ('questions' in a) return { kind: 'question', questions: a.questions }
  if (a.plan) return { kind: 'approval', plan: a.reason ?? 'Open the session to read the plan.' }
  return { kind: 'approval', command: a.command ?? a.file ?? a.reason }
}

const ANSWERED_ELSEWHERE = { ok: false, elsewhere: true, why: 'It no longer waits for an answer' }

const SIGNAL_OF: Record<AttentionEvent['kind'], string> = {
  approval: 'ask',
  exited: 'exit',
  'turn-done': 'done'
}

function signalKey(m: AttentionEvent): string {
  return `${SIGNAL_OF[m.kind]}:${m.sessionId}:${m.at}`
}

function isSignal(c: InboxCard): boolean {
  return c.source === KOLOFT_SOURCE.id && !c.postedBy && /^(ask|exit|done):/.test(c.key)
}

function waitsOnTheOwner(m: AttentionEvent, judging: (tabId: string) => boolean): boolean {
  if (m.kind !== 'turn-done') return true
  return !m.fyi && !judging(m.tabId)
}

export function where(s: AskedSession): Record<string, string> {
  return {
    ...(s.workspace && { workspace: s.workspace }),
    ...(s.machine && { machine: s.machine })
  }
}

function asQuestions(qs: Question[], backend: BackendId): InboxQuestion[] {
  return qs.map((q, i) => ({
    id: `q${i}`,
    text: q.question,
    multi: !!q.multiSelect,
    ownAnswer: backend === 'claude' || !!q.ownWords,
    options: q.options.map((o, j) => ({
      id: `o${j}`,
      label: o.label,
      ...(o.description && { detail: o.description })
    }))
  }))
}

export function replyFor(
  qs: InboxQuestion[],
  given: InboxAnswers[string] | undefined
): string | undefined {
  if (!given || typeof given === 'string') return undefined
  const lines = qs.map((q) => {
    const a = given[q.id]
    if (!a) return undefined
    if (!Array.isArray(a)) return a.own.trim()
    return a.map((id) => q.options.findIndex((o) => o.id === id) + 1).join(', ')
  })
  return lines.every(Boolean) ? lines.join('\n') : undefined
}

const ANSWERED = { state: 'closed' as const, status: 'Answered' }
const HANDLED = { state: 'closed' as const, status: 'Handled in its tab' }

export function askCard(
  m: AttentionEvent,
  s: AskedSession,
  ask: KoloftAsk | undefined
): InboxCardInput {
  const base = {
    key: signalKey(m),
    level: 'high' as const,
    session: s.sessionId,
    where: where(s),
    happenedAt: m.at,
    links: [{ label: 'Open session', to: { type: 'session' as const, session: s.sessionId } }]
  }
  if (ask?.kind === 'question' && ask.questions.length) {
    const questions = asQuestions(ask.questions, s.backend)
    const one = questions.length === 1 && !questions[0].multi
    return {
      ...base,
      title: `“${s.title}” asks ${questions.length === 1 ? 'a question' : `${questions.length} questions`}`,
      blocks: [{ type: 'choice', id: 'q', questions }],
      actions: [
        {
          id: 'answer',
          label: one ? 'Answer' : 'Send answers',
          style: 'main',
          takes: ['q'],
          busyText: 'Sending your answer…',
          run: { type: 'session', session: CARD_SESSION, answer: 'q' },
          then: { done: ANSWERED, elsewhere: HANDLED }
        }
      ]
    }
  }
  if (ask?.kind === 'approval') {
    const what = ask.plan ?? ask.command
    return {
      ...base,
      title: ask.plan
        ? `“${s.title}” asks you to approve a plan`
        : `“${s.title}” wants to run a command`,
      blocks: what ? [{ type: 'quote', who: ask.plan ? 'Plan' : 'Command', text: what }] : [],
      actions: [
        {
          id: 'allow',
          label: ask.plan ? 'Approve' : 'Allow',
          style: 'main',
          busyText: 'Telling it yes…',
          run: { type: 'session', session: CARD_SESSION, answer: 'yes' },
          then: { done: ANSWERED, elsewhere: HANDLED }
        },
        {
          id: 'deny',
          label: ask.plan ? 'Reject' : 'Deny',
          busyText: 'Telling it no…',
          run: { type: 'session', session: CARD_SESSION, answer: 'no' },
          then: { done: ANSWERED, elsewhere: HANDLED }
        }
      ]
    }
  }
  return {
    ...base,
    title: `“${s.title}” is waiting for you in its tab`,
    blocks: [
      { type: 'text', text: 'Koloft cannot show what it asks here. Open the session to answer it.' }
    ]
  }
}

const LAST_WORDS_SHOWN = 900

export function doneCard(
  m: AttentionEvent,
  s: AskedSession,
  reply: string | undefined
): InboxCardInput {
  const said = reply?.trim()
  return {
    key: signalKey(m),
    level: 'normal',
    session: s.sessionId,
    where: where(s),
    happenedAt: m.at,
    title: `“${s.title}” finished and waits for you`,
    blocks: [
      ...(said
        ? [
            {
              type: 'quote' as const,
              who: 'It said',
              text: said.length > LAST_WORDS_SHOWN ? `…${said.slice(-LAST_WORDS_SHOWN)}` : said
            }
          ]
        : []),
      { type: 'input', id: 'reply', placeholder: 'Reply to it…', required: true }
    ],
    actions: [
      {
        id: 'reply',
        label: 'Send',
        style: 'main',
        takes: ['reply'],
        busyText: 'Sending…',
        run: { type: 'session', session: CARD_SESSION, message: '{answer:reply}' },
        then: { done: { state: 'closed', status: 'Replied' } }
      }
    ],
    links: [{ label: 'Open session', to: { type: 'session', session: s.sessionId } }]
  }
}

export function exitCard(m: AttentionEvent, s: AskedSession): InboxCardInput {
  const remote = !!s.machine
  return {
    key: signalKey(m),
    level: 'normal',
    session: s.sessionId,
    where: where(s),
    happenedAt: m.at,
    title: `“${s.title}” stopped unexpectedly`,
    blocks: [
      {
        type: 'facts',
        items: [
          { text: `${BACKEND_LABEL[s.backend]} quit`, tone: 'bad' },
          { text: remote ? `on ${s.machine}` : 'on this Mac' }
        ]
      },
      { type: 'input', id: 'note', placeholder: 'A note for a new session, if you hand it over…' }
    ],
    suggestion: {
      text: 'Start it again where it left off: nothing in its work is lost.',
      action: 'restart'
    },
    actions: [
      {
        id: 'restart',
        label: 'Start it again',
        style: 'main',
        busyText: 'Starting it again…',
        run: { type: 'session', session: CARD_SESSION, message: CARRY_ON },
        then: { done: { state: 'closed', status: 'Restarted' } }
      },
      {
        id: 'handoff',
        label: 'Hand to a new session',
        takes: ['note'],
        run: {
          type: 'new-session',
          backend: s.backend,
          name: `Pick up “${s.title}”`.slice(0, 60),
          task: `Pick up the work of the session “${s.title}”, which stopped unexpectedly. The owner’s note: {answer:note}`
        },
        then: { done: { state: 'closed', status: 'Handed to a new session' } }
      },
      ...(remote
        ? []
        : [
            {
              id: 'close',
              label: 'Close it for good',
              style: 'danger' as const,
              confirm:
                'It starts once more only to wrap up, then closes its tab and deletes its worktree and branch.',
              busyText: 'Telling it to wrap up…',
              run: { type: 'session' as const, session: CARD_SESSION, message: CLOSE_YOURSELF },
              then: { done: { state: 'in-progress' as const, status: 'Closing it' } }
            }
          ])
    ],
    links: [{ label: 'Open session', to: { type: 'session', session: s.sessionId } }]
  }
}

// ADR-0049
export class KoloftInbox {
  private building = new Set<string>()

  constructor(private d: KoloftInboxDeps) {
    d.inbox.register(KOLOFT_SOURCE)
  }

  sync(): void {
    const wanted = new Map<string, AttentionEvent>()
    for (const m of this.d.marks())
      if (m.sessionId && waitsOnTheOwner(m, this.d.judging)) wanted.set(signalKey(m), m)
    for (const c of this.d.inbox.all()) {
      if (
        !isSignal(c) ||
        c.state !== 'needs-you' ||
        wanted.has(c.key) ||
        c.press?.step === 'working'
      )
        continue
      try {
        this.d.inbox.move(
          KOLOFT,
          c.key,
          c.key.startsWith('exit:') ? { state: 'closed', status: 'Started again' } : HANDLED,
          'it no longer waits for you'
        )
      } catch {}
    }
    for (const [key, m] of wanted) if (!this.d.inbox.find(KOLOFT, key)) void this.post(m, true)
  }

  private async post(m: AttentionEvent, retry: boolean): Promise<void> {
    const key = signalKey(m)
    if (this.building.has(key)) return
    this.building.add(key)
    try {
      const s = this.d.sessionOfTab(m.tabId)
      if (!s) return
      const ask = m.kind === 'approval' ? await this.d.askOf(m.tabId) : undefined
      const reply = m.kind === 'turn-done' ? await this.d.lastReply(s.sessionId) : undefined
      const current = this.d.marks().find((x) => signalKey(x) === key)
      if (!current || !waitsOnTheOwner(current, this.d.judging)) return
      const existing = this.d.inbox.find(KOLOFT, key)
      if (existing?.state === 'closed') return
      const card =
        m.kind === 'exited'
          ? exitCard(m, s)
          : m.kind === 'turn-done'
            ? doneCard(m, s, reply)
            : askCard(m, s, ask)
      if (
        existing &&
        JSON.stringify([existing.title, existing.blocks, existing.actions]) ===
          JSON.stringify([card.title, card.blocks, card.actions])
      )
        return
      this.d.inbox.add(KOLOFT, card)
      if (m.kind === 'approval' && !ask && retry)
        setTimeout(() => void this.post(m, false), DETAILS_RETRY_MS)
    } catch {
      return
    } finally {
      this.building.delete(key)
    }
  }

  asked(tabId: string): void {
    for (const m of this.d.marks())
      if (m.tabId === tabId && m.kind === 'approval') void this.post(m, false)
  }

  sessionGone(sessionId: string, why: string): void {
    for (const c of this.d.inbox.all()) {
      if (c.source !== KOLOFT_SOURCE.id || c.state === 'closed' || c.press?.step === 'working')
        continue
      if (c.session !== sessionId && c.postedBy !== sessionId) continue
      try {
        this.d.inbox.move(
          { ...KOLOFT, ...(c.postedBy && { as: c.postedBy }) },
          c.key,
          { state: 'closed', status: why },
          why
        )
      } catch {}
    }
  }

  async answer(
    ref: string,
    given: { answers?: InboxAnswers[string]; pick?: string }
  ): Promise<AnswerResult> {
    const live = this.d.liveTabOf(ref)
    if (!live || !this.d.marks().some((m) => m.tabId === live.tabId && m.kind === 'approval'))
      return ANSWERED_ELSEWHERE
    let reply = given.pick
    if (reply === undefined) {
      const ask = await this.d.askOf(live.tabId)
      if (ask?.kind !== 'question') return ANSWERED_ELSEWHERE
      reply = replyFor(asQuestions(ask.questions, live.backend), given.answers)
      if (reply === undefined) return { ok: false, why: 'Some question has no answer yet' }
    }
    const error = await this.d.answer(live.tabId, reply)
    if (error === SHOWS_NO_DIALOG) return ANSWERED_ELSEWHERE
    return error === undefined ? { ok: true } : { ok: false, why: error }
  }

  rebound(oldRef: string, newKey: string): void {
    if (oldRef && oldRef !== newKey) this.d.inbox.rekeySession(oldRef, newKey)
  }
}

export function inboxFooter(card: InboxCard, lets: string[] | undefined): string {
  if (!lets?.length)
    return `This came from the Inbox card ${card.key}. Koloft moves that card itself.`
  return `This came from the Inbox card ${card.key}. When you are done, move it with koloft inbox move ${card.key} <${lets.join('|')}> -- "<what happened, in a few words>".`
}
