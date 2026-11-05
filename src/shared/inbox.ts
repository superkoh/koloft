export const INBOX_STATES = ['needs-you', 'in-progress', 'closed'] as const
export type InboxState = (typeof INBOX_STATES)[number]
export const INBOX_LEVELS = ['high', 'normal', 'low'] as const
export type InboxLevel = (typeof INBOX_LEVELS)[number]
export const INBOX_OUTCOMES = ['done', 'failed', 'elsewhere'] as const
export type InboxOutcome = (typeof INBOX_OUTCOMES)[number]
export type InboxSort = 'priority' | 'newest' | 'oldest'

export const UNDO_MS = 5000
export const DONE_KEPT_MS = 7 * 24 * 3600 * 1000
export const OPEN_STATES: InboxState[] = ['needs-you', 'in-progress']

export const INBOX_LIMIT = {
  key: 200,
  name: 24,
  title: 120,
  status: 40,
  line: 160,
  label: 24,
  busy: 40,
  text: 1000,
  whereValue: 60,
  blocks: 6,
  actions: 8,
  links: 4,
  facts: 8,
  questions: 4,
  options: 8,
  chain: 5,
  openCardsPerSource: 200
} as const

export interface InboxOption {
  id: string
  label: string
  detail?: string
}

export interface InboxQuestion {
  id: string
  text: string
  multi: boolean
  ownAnswer: boolean
  recommended?: string
  options: InboxOption[]
}

export interface InboxFact {
  text: string
  tone?: 'good' | 'bad'
}

export type InboxBlock =
  | { type: 'text'; text: string }
  | { type: 'quote'; who: string; text: string }
  | { type: 'facts'; items: InboxFact[] }
  | { type: 'chain'; steps: { text: string }[] }
  | { type: 'choice'; id: string; questions: InboxQuestion[] }
  | { type: 'input'; id: string; placeholder?: string; required?: boolean }

export interface InboxTarget {
  state: InboxState
  status?: string
}

export type InboxRun =
  | { type: 'session'; session: string; message: string; answer?: undefined }
  | { type: 'session'; session: string; answer: string; message?: undefined }
  | {
      type: 'new-session'
      task: string
      workspace?: string
      backend?: string
      model?: string
      name?: string
      worktree?: string
    }

export const CARD_SESSION = 'card'

export interface InboxAction {
  id: string
  label: string
  style?: 'main' | 'normal' | 'danger'
  confirm?: string
  takes?: string[]
  busyText?: string
  in?: InboxState[]
  run: InboxRun
  then?: Partial<Record<InboxOutcome, InboxTarget>>
  lets?: InboxState[]
}

export type InboxLinkTo =
  | { type: 'session'; session: string }
  | { type: 'changes'; session: string }
  | { type: 'page'; session: string; url: string }
  | { type: 'browser'; url: string }

export interface InboxLink {
  label: string
  to: InboxLinkTo
  auto?: boolean
}

export interface InboxCardBody {
  title: string
  status: string
  level: InboxLevel
  where: Record<string, string>
  session: string | null
  happenedAt: number | null
  blocks: InboxBlock[]
  suggestion: { text: string; action?: string } | null
  actions: InboxAction[]
  links: InboxLink[]
}

export type InboxCardInput = Partial<Omit<InboxCardBody, 'title' | 'level'>> & {
  key: string
  title: string
  level: InboxLevel
  state?: InboxState
  why?: string
}

export type ChoiceAnswer = Record<string, string[] | { own: string }>
export type InboxAnswers = Record<string, ChoiceAnswer | string>

export interface InboxPress {
  action: string
  step: 'confirm' | 'waiting' | 'working'
  answers: InboxAnswers
  try: number
  until?: number
}

export interface InboxNote {
  kind: 'result' | 'changed' | 'reply'
  outcome?: InboxOutcome
  text: string
  retry?: boolean
}

export interface InboxHistory {
  at: number
  from: InboxState
  to: InboxState
  status: string
  by: string
  why: string | null
}

export interface InboxCard extends InboxCardBody {
  id: string
  source: string
  sourceName: string
  key: string
  postedBy: string | null
  createdAt: number
  updatedAt: number
  version: number
  state: InboxState
  stateSince: number
  closedAt: number | null
  closedBy: string | null
  history: InboxHistory[]
  grants: { to: string; states: InboxState[] }[]
  press: InboxPress | null
  note: InboxNote | null
  lastPress: { action: string; answers: InboxAnswers; try: number } | null
  yourLevel: InboxLevel | null
  movedToTopAt: number | null
}

export interface InboxSnapshot {
  cards: InboxCard[]
  ready: string[]
}

export class InboxError extends Error {}

function fail(message: string): never {
  throw new InboxError(message)
}

function cut(text: string, max: number, warn: string[], what: string): string {
  if (text.length <= max) return text
  warn.push(`${what} was cut to ${max} characters`)
  return `${text.slice(0, max - 1)}…`
}

function isState(s: unknown): s is InboxState {
  return INBOX_STATES.includes(s as InboxState)
}

function checkTarget(t: unknown, what: string): InboxTarget {
  const o = (typeof t === 'string' ? { state: t } : t) as InboxTarget | undefined
  if (!o || !isState(o.state)) fail(`${what}: state must be one of ${INBOX_STATES.join(', ')}`)
  return { state: o.state, ...(o.status ? { status: String(o.status) } : {}) }
}

export function checkTargetInput(t: unknown): InboxTarget {
  return checkTarget(t, 'move')
}

function checkBlocks(blocks: InboxBlock[], warn: string[]): Set<string> {
  if (blocks.length > INBOX_LIMIT.blocks)
    fail(`at most ${INBOX_LIMIT.blocks} blocks, this card has ${blocks.length}`)
  const answerable = new Set<string>()
  for (const b of blocks) {
    if (b.type === 'text' || b.type === 'quote') {
      if (typeof b.text !== 'string') fail(`a ${b.type} block needs text`)
      b.text = cut(b.text, INBOX_LIMIT.text, warn, `${b.type} text`)
    } else if (b.type === 'facts') {
      if (!b.items?.length || b.items.length > INBOX_LIMIT.facts)
        fail(`facts take 1–${INBOX_LIMIT.facts} items`)
    } else if (b.type === 'chain') {
      if (!b.steps || b.steps.length < 2 || b.steps.length > INBOX_LIMIT.chain)
        fail(`a chain has 2–${INBOX_LIMIT.chain} steps`)
    } else if (b.type === 'choice') {
      if (!b.id) fail('a choice block needs an id')
      if (!b.questions?.length || b.questions.length > INBOX_LIMIT.questions)
        fail(`a choice block has 1–${INBOX_LIMIT.questions} questions`)
      for (const q of b.questions) {
        if (!q.id || !q.text) fail('a question needs an id and text')
        if (!q.options || q.options.length < 2 || q.options.length > INBOX_LIMIT.options)
          fail(`a question has 2–${INBOX_LIMIT.options} options`)
        if (q.recommended && (q.multi || !q.options.some((o) => o.id === q.recommended)))
          fail('recommended must be an option of a pick-one question')
      }
      answerable.add(b.id)
    } else if (b.type === 'input') {
      if (!b.id) fail('an input block needs an id')
      answerable.add(b.id)
    } else fail(`block type ${(b as { type: string }).type} is not one the Inbox knows`)
  }
  return answerable
}

function checkActions(
  actions: InboxAction[],
  answerable: Set<string>,
  session: string | null,
  warn: string[]
): InboxAction[] {
  if (actions.length > INBOX_LIMIT.actions)
    fail(`at most ${INBOX_LIMIT.actions} buttons, this card has ${actions.length}`)
  if (actions.filter((a) => a.style === 'main').length > 1) fail('only one main button')
  const ids = new Set<string>()
  return actions.map((a) => {
    if (!a.id || ids.has(a.id)) fail(`button ids must be there and different (${a.id})`)
    ids.add(a.id)
    if (!a.label) fail(`button ${a.id} needs a label`)
    if (a.style === 'danger' && !a.confirm) fail(`danger button ${a.id} needs a confirm sentence`)
    for (const t of a.takes ?? [])
      if (!answerable.has(t))
        fail(`button ${a.id} takes ${t}, which is no choice or input block on this card`)
    for (const s of a.in ?? [])
      if (!OPEN_STATES.includes(s)) fail(`button ${a.id}: closed cards have no buttons`)
    const run = a.run
    if (run?.type === 'session') {
      if (!run.session) fail(`button ${a.id} names no session`)
      if (!run.message && !run.answer)
        fail(`button ${a.id} sends to a session, so it needs a message or an answer`)
      if (run.answer && !a.then?.elsewhere)
        fail(`button ${a.id} answers a question, so then.elsewhere is needed`)
      if (run.session === CARD_SESSION && !session)
        fail(`button ${a.id} goes to the card's session, but the card names none`)
    } else if (run?.type === 'new-session') {
      if (!run.task) fail(`button ${a.id} starts a session, so it needs a task`)
    } else fail(`button ${a.id} needs run.type session or new-session`)
    const then: Partial<Record<InboxOutcome, InboxTarget>> = {}
    for (const [k, v] of Object.entries(a.then ?? {})) {
      if (!INBOX_OUTCOMES.includes(k as InboxOutcome))
        fail(`then.${k} is not a result the Inbox knows`)
      then[k as InboxOutcome] = checkTarget(v, `button ${a.id} then.${k}`)
    }
    for (const s of a.lets ?? []) if (!isState(s)) fail(`button ${a.id}: lets ${s} is not a state`)
    return {
      ...a,
      label: cut(a.label, INBOX_LIMIT.label, warn, 'button label'),
      ...(a.busyText ? { busyText: cut(a.busyText, INBOX_LIMIT.busy, warn, 'busy text') } : {}),
      ...(a.then ? { then } : {})
    }
  })
}

export function checkCardBody(input: InboxCardInput, warn: string[]): InboxCardBody {
  if (!input.title) fail('missing title')
  if (!INBOX_LEVELS.includes(input.level)) fail(`level must be ${INBOX_LEVELS.join(', ')}`)
  const where: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.where ?? {}))
    if (v) where[k] = cut(String(v), INBOX_LIMIT.whereValue, warn, `where.${k}`)
  const session = input.session ?? null
  const blocks = structuredClone(input.blocks ?? [])
  const answerable = checkBlocks(blocks, warn)
  const actions = checkActions(input.actions ?? [], answerable, session, warn)
  if (input.suggestion?.action && !actions.some((a) => a.id === input.suggestion?.action))
    fail(`suggestion.action ${input.suggestion.action} is not a button on this card`)
  const links = input.links ?? []
  if (links.length > INBOX_LIMIT.links) fail(`at most ${INBOX_LIMIT.links} links`)
  for (const l of links)
    if (!['session', 'changes', 'page', 'browser'].includes(l.to?.type))
      fail(`link type ${l.to?.type} is not one the Inbox knows`)
  return {
    title: cut(input.title, INBOX_LIMIT.title, warn, 'title'),
    status: cut(input.status ?? '', INBOX_LIMIT.status, warn, 'status'),
    level: input.level,
    where,
    session,
    happenedAt: input.happenedAt ?? null,
    blocks,
    suggestion: input.suggestion
      ? {
          ...input.suggestion,
          text: cut(input.suggestion.text, INBOX_LIMIT.line, warn, 'suggestion')
        }
      : null,
    actions,
    links: links.map((l) => ({ ...l, label: cut(l.label, INBOX_LIMIT.label, warn, 'link label') }))
  }
}

export function levelOf(card: Pick<InboxCard, 'level' | 'yourLevel'>): InboxLevel {
  return card.yourLevel ?? card.level
}

export function visibleActions(card: InboxCard): InboxAction[] {
  if (card.state === 'closed') return []
  return card.actions.filter((a) => (a.in ?? OPEN_STATES).includes(card.state))
}

export function answersComplete(
  card: InboxCard,
  action: InboxAction,
  answers: InboxAnswers
): boolean {
  for (const id of action.takes ?? []) {
    const block = card.blocks.find((b) => 'id' in b && b.id === id)
    if (block?.type === 'input') {
      if (block.required && !String(answers[id] ?? '').trim()) return false
      continue
    }
    if (block?.type !== 'choice') continue
    const given = answers[id]
    if (!given || typeof given === 'string') return false
    for (const q of block.questions) {
      const a = given[q.id]
      if (!a || (Array.isArray(a) && !a.length) || (!Array.isArray(a) && !a.own.trim()))
        return false
    }
  }
  return true
}

export function pickToPress(
  card: InboxCard
): { action: InboxAction; block: string; question: InboxQuestion } | null {
  const acts = visibleActions(card)
  if (acts.length !== 1 || acts[0].takes?.length !== 1) return null
  const block = card.blocks.find((b) => b.type === 'choice' && b.id === acts[0].takes?.[0])
  if (block?.type !== 'choice' || block.questions.length !== 1 || block.questions[0].multi)
    return null
  return { action: acts[0], block: block.id, question: block.questions[0] }
}

function answerText(card: InboxCard, id: string, answers: InboxAnswers): string {
  const block = card.blocks.find((b) => 'id' in b && b.id === id)
  const a = answers[id]
  if (!block || a === undefined) return '(nothing)'
  if (block.type === 'input') return `«${String(a)}»`
  if (block.type !== 'choice' || typeof a === 'string') return '(nothing)'
  return block.questions
    .map((q) => {
      const v = a[q.id]
      if (!v) return `${q.text} (no answer)`
      if (!Array.isArray(v)) return `${q.text} «${v.own}»`
      return `${q.text} «${v.map((o) => q.options.find((x) => x.id === o)?.label ?? o).join(', ')}»`
    })
    .join('; ')
}

export function fillTemplate(template: string, card: InboxCard, answers: InboxAnswers): string {
  return template
    .replaceAll('{title}', card.title)
    .replaceAll('{key}', card.key)
    .replaceAll('{status}', card.status)
    .replace(/\{answer:([^}]+)\}/g, (_, id: string) => answerText(card, id, answers))
    .replaceAll(
      '{answers}',
      Object.keys(answers)
        .map((id) => answerText(card, id, answers))
        .join('; ') || '(nothing)'
    )
}

export function envelopeHead(card: InboxCard, action: InboxAction): string {
  return `(From Inbox: the owner pressed “${action.label}” on card ${card.key} of ${card.sourceName}:)`
}

export interface InboxFilters {
  source?: string
  where?: Record<string, string>
  sort?: InboxSort
}

function matches(card: InboxCard, f: InboxFilters): boolean {
  if (f.source && card.source !== f.source) return false
  for (const [k, v] of Object.entries(f.where ?? {})) if (v && card.where[k] !== v) return false
  return true
}

function stillShown(card: InboxCard, now: number): boolean {
  return card.state !== 'closed' || now - (card.closedAt ?? now) <= DONE_KEPT_MS
}

export function cardsIn(
  cards: InboxCard[],
  state: InboxState,
  f: InboxFilters,
  now: number
): InboxCard[] {
  const here = cards.filter((c) => c.state === state && stillShown(c, now) && matches(c, f))
  const when = (c: InboxCard): number => c.happenedAt ?? c.createdAt
  if (state === 'closed') return here.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
  if (f.sort === 'newest')
    return here.sort((a, b) => when(b) - when(a) || b.createdAt - a.createdAt)
  if (f.sort === 'oldest')
    return here.sort((a, b) => when(a) - when(b) || a.createdAt - b.createdAt)
  const key = (c: InboxCard): number[] => [
    INBOX_LEVELS.indexOf(levelOf(c)),
    -(c.movedToTopAt ?? 0),
    when(c),
    c.createdAt
  ]
  return here.sort((a, b) => {
    const x = key(a)
    const y = key(b)
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
  })
}

export interface InboxFacet {
  value: string
  label: string
  n: number
}

export function facetsOf(
  cards: InboxCard[],
  state: InboxState,
  now: number
): Record<string, InboxFacet[]> {
  const out: Record<string, Map<string, InboxFacet>> = { source: new Map() }
  for (const c of cards) {
    if (c.state !== state || !stillShown(c, now)) continue
    const bump = (key: string, value: string, label: string): void => {
      const m = (out[key] ??= new Map())
      const cur = m.get(value)
      m.set(value, { value, label, n: (cur?.n ?? 0) + 1 })
    }
    bump('source', c.source, c.sourceName)
    for (const [k, v] of Object.entries(c.where)) bump(k, v, v)
  }
  return Object.fromEntries(Object.entries(out).map(([k, m]) => [k, [...m.values()]]))
}

export interface InboxCounts {
  badge: number
  high: boolean
  byState: Record<InboxState, number>
}

export function inboxCounts(cards: InboxCard[], now: number): InboxCounts {
  const shown = cards.filter((c) => stillShown(c, now))
  const waiting = shown.filter((c) => c.state === 'needs-you' && levelOf(c) !== 'low')
  return {
    badge: waiting.length,
    high: waiting.some((c) => levelOf(c) === 'high'),
    byState: {
      'needs-you': shown.filter((c) => c.state === 'needs-you').length,
      'in-progress': shown.filter((c) => c.state === 'in-progress').length,
      closed: shown.filter((c) => c.state === 'closed').length
    }
  }
}
