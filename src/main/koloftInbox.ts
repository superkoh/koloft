import type { AttentionEvent, BackendId } from '@shared/types'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import type { ReplyChoices, Verdict } from './turnNews'
import {
  CARD_SESSION,
  type InboxAction,
  type InboxAnswers,
  type InboxBlock,
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
  ANSWER_NOT_TAKEN,
  type Question
} from './discord/dialog'
import { SHOWS_NO_DIALOG } from './discord/relay'

export const KOLOFT_SOURCE = { id: 'koloft', name: 'Koloft' }
const KOLOFT: InboxCaller = { source: KOLOFT_SOURCE.id }
const DETAILS_RETRY_MS = 1500
export const ANSWER_NOT_TAKEN_ON_A_CARD = `${ANSWER_NOT_TAKEN} Open the session and answer it there.`

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
  butlerSide(tabId: string): boolean
  watching(): string | null
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

export const ASKED_BEFORE_IT_STOPPED =
  'Its session stopped after asking, so its tab no longer shows this. Your answer reaches it as a message.'
const PLAN_BEFORE_IT_STOPPED =
  'Its session stopped after asking, so its tab no longer shows the plan. “Show it again” asks it for the plan once more.'

const afterStop = (waited: string, then: string): string =>
  `Your session stopped while your ${waited} waited for the owner, so it no longer shows on your screen. ${then}`
export const ALLOW_AFTER_STOP = afterStop('command', 'The owner allows it: run it now.')
export const DENY_AFTER_STOP = afterStop(
  'command',
  'The owner does not allow it: do not run it, and carry on without it.'
)
export const SHOW_PLAN_AGAIN = afterStop(
  'plan',
  'Ask for approval of the same plan again, the same way as before.'
)
const REJECT_PLAN_AFTER_STOP = afterStop('plan', 'The owner rejects the plan: do not carry it out.')
const APPROVE_PLAN = 'approve'
const PLAN_QUOTE = 'Plan'
const NOT_BACK_YET = {
  ok: false,
  why: 'Its session has not come back since Koloft started again. Try once it has.'
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
  return (
    c.source === KOLOFT_SOURCE.id &&
    !c.postedBy &&
    Object.values(SIGNAL_OF).includes(c.key.split(':')[0])
  )
}

const GONE_STATUS: Record<string, string> = {
  exit: 'Started again',
  done: 'It went on'
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

const PLAN_ASKED_AGAIN = { state: 'closed' as const, status: 'Asked to show it again' }

function isPlan(c: InboxCard): boolean {
  return (
    c.actions.some((a) => a.id === APPROVE_PLAN) ||
    c.blocks.some((b) => b.type === 'quote' && b.who === PLAN_QUOTE)
  )
}

function answeredByMessage(c: InboxCard): boolean {
  return (
    c.key.startsWith(`${SIGNAL_OF.approval}:`) &&
    c.actions.some((a) => a.run.type === 'session' && a.run.message !== undefined)
  )
}

function sayAfterStop(plan: boolean): (a: InboxAction) => InboxAction {
  return (a) => {
    const say = (message: string): InboxAction => ({
      ...a,
      run: { type: 'session', session: CARD_SESSION, message },
      then: { done: ANSWERED }
    })
    if (a.id === 'answer' && a.takes?.length)
      return say(afterStop('question', `The owner answers: {answer:${a.takes[0]}}`))
    if (plan && a.style === 'main')
      return {
        ...say(SHOW_PLAN_AGAIN),
        label: 'Show it again',
        busyText: 'Asking it for the plan…',
        then: { done: PLAN_ASKED_AGAIN }
      }
    if (plan) return say(REJECT_PLAN_AFTER_STOP)
    if (a.id === 'allow') return say(ALLOW_AFTER_STOP)
    if (a.id === 'deny') return say(DENY_AFTER_STOP)
    return a
  }
}

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
    const plan = ask.plan !== undefined
    const what = ask.plan ?? ask.command
    return {
      ...base,
      title: plan
        ? `“${s.title}” asks you to approve a plan`
        : `“${s.title}” wants to run a command`,
      blocks: what ? [{ type: 'quote', who: plan ? PLAN_QUOTE : 'Command', text: what }] : [],
      actions: [
        {
          id: plan ? APPROVE_PLAN : 'allow',
          label: plan ? 'Approve' : 'Allow',
          style: 'main',
          busyText: 'Telling it yes…',
          run: { type: 'session', session: CARD_SESSION, answer: 'yes' },
          then: { done: ANSWERED, elsewhere: HANDLED }
        },
        {
          id: plan ? 'reject' : 'deny',
          label: plan ? 'Reject' : 'Deny',
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

function lastWords(said: string): string {
  const chars = Array.from(said)
  return chars.length > LAST_WORDS_SHOWN ? `…${chars.slice(-LAST_WORDS_SHOWN).join('')}` : said
}

function replyBlock(choices: ReplyChoices | undefined): InboxBlock {
  if (!choices) return { type: 'input', id: 'reply', placeholder: 'Reply to it…', required: true }
  return {
    type: 'choice',
    id: 'reply',
    questions: [
      {
        id: 'q',
        text: choices.question,
        multi: false,
        ownAnswer: true,
        options: choices.options.map((label, i) => ({ id: `o${i}`, label }))
      }
    ]
  }
}

export function doneCard(
  m: AttentionEvent,
  s: AskedSession,
  reply: string | undefined,
  choices?: ReplyChoices
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
              text: lastWords(said)
            }
          ]
        : []),
      replyBlock(choices)
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
  private finished = new Map<string, { reply: string; forTheOwner: boolean }>()
  private planAskedAgain = new Set<string>()

  constructor(private d: KoloftInboxDeps) {
    d.inbox.register(KOLOFT_SOURCE)
  }

  sync(): void {
    const marks = this.d.marks().filter((m) => m.sessionId)
    const standing = new Set(marks.map(signalKey))
    const askOnceOnScreen = new Set(
      marks.filter((m) => m.kind === 'turn-done').map((m) => signalKey({ ...m, kind: 'approval' }))
    )
    for (const c of this.d.inbox.all()) {
      if (
        !isSignal(c) ||
        c.state !== 'needs-you' ||
        standing.has(c.key) ||
        c.press?.step === 'working'
      )
        continue
      if (askOnceOnScreen.has(c.key)) {
        if (this.agentStoppedWithKoloft(c)) {
          this.answerByMessage(c)
          this.showPlanAgain(c)
        }
        continue
      }
      try {
        this.d.inbox.move(
          KOLOFT,
          c.key,
          { state: 'closed', status: GONE_STATUS[c.key.split(':')[0]] ?? HANDLED.status },
          'it no longer waits for you'
        )
      } catch {}
    }
    for (const m of marks) {
      if (m.kind === 'turn-done') continue
      const card = this.d.inbox.find(KOLOFT, signalKey(m))
      if (!card || (card.state === 'needs-you' && answeredByMessage(card))) void this.post(m, true)
    }
  }

  // ADR-0039
  private agentStoppedWithKoloft(c: InboxCard): boolean {
    if (!c.where.machine) return true
    return !!c.session && this.d.liveTabOf(c.session)?.backend === 'codex'
  }

  // CC§3 CODEX§34 MUSE§11 AGY§14
  private answerByMessage(c: InboxCard): void {
    if (!c.actions.length || answeredByMessage(c)) return
    try {
      this.d.inbox.update(KOLOFT, c.key, {
        blocks: [
          ...c.blocks.map((b) =>
            b.type === 'choice'
              ? { ...b, questions: b.questions.map((q) => ({ ...q, ownAnswer: true })) }
              : b
          ),
          { type: 'text', text: isPlan(c) ? PLAN_BEFORE_IT_STOPPED : ASKED_BEFORE_IT_STOPPED }
        ],
        actions: c.actions.map(sayAfterStop(isPlan(c)))
      })
    } catch {}
  }

  private showPlanAgain(c: InboxCard): void {
    const showAgain = c.actions.find((a) => a.style === 'main')
    if (
      !isPlan(c) ||
      !showAgain ||
      c.press ||
      !c.session ||
      this.planAskedAgain.has(c.key) ||
      !this.d.liveTabOf(c.session)
    )
      return
    this.planAskedAgain.add(c.key)
    try {
      this.d.inbox.press(c.id, showAgain.id, {})
    } catch {}
  }

  turnEnded(tabId: string, reply: string, handedOff: boolean): void {
    this.finished.set(tabId, { reply, forTheOwner: !handedOff && !this.d.butlerSide(tabId) })
  }

  judged(tabId: string, verdict: Verdict): void {
    const turn = this.finished.get(tabId)
    this.finished.delete(tabId)
    if (verdict.news || !turn?.forTheOwner || this.d.watching() === tabId) return
    const m = this.d.marks().find((x) => x.tabId === tabId && x.kind === 'turn-done' && !x.fyi)
    const s = this.d.sessionOfTab(tabId)
    if (!m?.sessionId || !s || this.d.inbox.find(KOLOFT, signalKey(m))) return
    try {
      this.d.inbox.add(KOLOFT, doneCard(m, s, turn.reply, verdict.choices))
    } catch {}
  }

  private async post(m: AttentionEvent, retry: boolean): Promise<void> {
    const key = signalKey(m)
    if (this.building.has(key)) return
    this.building.add(key)
    try {
      const s = this.d.sessionOfTab(m.tabId)
      if (!s) return
      const ask = m.kind === 'approval' ? await this.d.askOf(m.tabId) : undefined
      if (!this.d.marks().some((x) => signalKey(x) === key)) return
      const existing = this.d.inbox.find(KOLOFT, key)
      if (existing?.state === 'closed') return
      const keepsItsAnswerByMessage = !ask && existing && answeredByMessage(existing)
      if (keepsItsAnswerByMessage) {
        if (retry) setTimeout(() => void this.post(m, false), DETAILS_RETRY_MS)
        return
      }
      const card = m.kind === 'exited' ? exitCard(m, s) : askCard(m, s, ask)
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
      return this.d.marks().some((m) => m.sessionId === ref && m.wasAsking)
        ? NOT_BACK_YET
        : ANSWERED_ELSEWHERE
    let reply = given.pick
    if (reply === undefined) {
      const ask = await this.d.askOf(live.tabId)
      if (ask?.kind !== 'question') return ANSWERED_ELSEWHERE
      reply = replyFor(asQuestions(ask.questions, live.backend), given.answers)
      if (reply === undefined) return { ok: false, why: 'Some question has no answer yet' }
    }
    const error = await this.d.answer(live.tabId, reply)
    if (error === SHOWS_NO_DIALOG) return ANSWERED_ELSEWHERE
    if (error === ANSWER_NOT_TAKEN)
      return { ok: false, why: ANSWER_NOT_TAKEN_ON_A_CARD, retryHelps: false }
    if (error !== undefined) return { ok: false, why: error }
    return { ok: true }
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
