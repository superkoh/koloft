import {
  CARD_SESSION,
  DONE_KEPT_MS,
  INBOX_LIMIT,
  UNDO_MS,
  answersComplete,
  checkCardBody,
  checkTargetInput,
  envelopeHead,
  fail,
  fillTemplate,
  visibleActions,
  type InboxAction,
  type InboxAnswers,
  type InboxCard,
  type InboxCardBody,
  type InboxCardInput,
  type InboxLevel,
  type InboxLink,
  type InboxOutcome,
  type InboxRun,
  type InboxSnapshot,
  type InboxState,
  type InboxTarget
} from '@shared/inbox'

export interface InboxCaller {
  source: string
  as?: string
}

export interface SendResult {
  ok: boolean
  session?: string
  text?: string
  why?: string
}

export interface AnswerResult {
  ok: boolean
  elsewhere?: boolean
  why?: string
  retryHelps?: boolean
}

export interface StartResult {
  ok: boolean
  session?: string
  name?: string
  why?: string
}

export type StartSpec = Omit<Extract<InboxRun, { type: 'new-session' }>, 'type'>

export interface InboxHost {
  now(): number
  sendToSession(session: string, text: string, toItsOwnSession: boolean): Promise<SendResult>
  answerSession(
    session: string,
    answer: { answers?: InboxAnswers[string]; pick?: string }
  ): Promise<AnswerResult>
  startSession(
    spec: StartSpec,
    card: InboxCard,
    onReply: (reply: string) => void
  ): Promise<StartResult>
  footer(card: InboxCard, action: InboxAction): string
  changed(): void
}

interface Result {
  outcome: InboxOutcome
  text: string
  retryHelps?: boolean
}

// ADR-0028
function goesToItsOwnSession(card: InboxCard, to: string): boolean {
  return to === card.session && (card.postedBy ?? to) === to
}

// ADR-0049
export class Inbox {
  private sources = new Map<string, string>()
  private cards = new Map<string, InboxCard>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private seq = 0

  constructor(
    private host: InboxHost,
    saved: InboxSnapshot | null = null
  ) {
    if (saved) this.restore(saved)
  }

  private restore(saved: InboxSnapshot): void {
    for (const c of saved.cards) {
      if (c.press) {
        c.note = {
          kind: 'result',
          outcome: 'failed',
          retry: true,
          text:
            c.press.step === 'working'
              ? 'Koloft restarted, so it does not know whether this finished — have a look'
              : 'Koloft quit before this was sent, so nothing was sent'
        }
        c.lastPress = { action: c.press.action, answers: c.press.answers, try: c.press.try }
      }
      c.press = null
      this.cards.set(c.id, c)
      this.seq = Math.max(this.seq, Number(c.id.slice(1)) || 0)
    }
    this.prune()
  }

  snapshot(): InboxSnapshot {
    return { cards: [...this.cards.values()], ready: [...this.sources.keys()] }
  }

  all(): InboxCard[] {
    return [...this.cards.values()]
  }

  isReady(sourceId: string): boolean {
    return this.sources.has(sourceId)
  }

  register(def: { id: string; name: string }): void {
    if (!def.id || !def.name) fail('a source needs an id and a name')
    const name = def.name.slice(0, INBOX_LIMIT.name)
    this.sources.set(def.id, name)
    for (const c of this.cards.values()) if (c.source === def.id) c.sourceName = name
    this.host.changed()
  }

  unregister(id: string): void {
    if (!this.sources.delete(id)) fail(`source ${id} is not registered`)
    for (const c of this.cards.values()) {
      if (c.source !== id || c.state === 'closed') continue
      this.cancelPress(c, null)
      this.setState(
        c,
        { state: 'closed', status: 'Source is gone' },
        'inbox',
        'its source unregistered'
      )
    }
    this.host.changed()
  }

  private source(caller: InboxCaller): { id: string; name: string } {
    const name = this.sources.get(caller.source)
    if (name === undefined) fail(`source ${caller.source} is not registered with the Inbox`)
    return { id: caller.source, name }
  }

  find(caller: InboxCaller, key: string): InboxCard | undefined {
    for (const c of this.cards.values())
      if (c.source === caller.source && c.key === key && c.postedBy === (caller.as ?? null))
        return c
    return undefined
  }

  private prune(): void {
    const now = this.host.now()
    for (const c of this.cards.values())
      if (c.state === 'closed' && now - (c.closedAt ?? now) > DONE_KEPT_MS) this.cards.delete(c.id)
  }

  add(
    caller: InboxCaller,
    input: InboxCardInput
  ): { id: string; created: boolean; warnings: string[] } {
    const source = this.source(caller)
    if (!input?.key || input.key.length > INBOX_LIMIT.key)
      fail(`a card needs a key of 1–${INBOX_LIMIT.key} characters`)
    this.prune()
    let existing = this.find(caller, input.key)
    if (existing?.state === 'closed') {
      this.cards.delete(existing.id)
      existing = undefined
    }
    const state = input.state ?? existing?.state ?? 'needs-you'
    checkTargetInput(state)
    if (!existing && state === 'closed') fail('a new card cannot start closed')
    const warnings: string[] = []
    const body = checkCardBody(input, warnings)
    const now = this.host.now()
    if (!existing) {
      const open = this.all().filter((c) => c.source === source.id && c.state !== 'closed').length
      if (open >= INBOX_LIMIT.openCardsPerSource)
        fail(`source ${source.id} already has ${INBOX_LIMIT.openCardsPerSource} open cards`)
      const card: InboxCard = {
        ...body,
        id: `c${++this.seq}`,
        source: source.id,
        sourceName: source.name,
        key: input.key,
        postedBy: caller.as ?? null,
        createdAt: now,
        state,
        stateSince: now,
        closedAt: null,
        closedBy: null,
        history: [],
        grants: [],
        press: null,
        note: null,
        lastPress: null,
        yourLevel: null,
        movedToTopAt: null
      }
      this.cards.set(card.id, card)
      this.host.changed()
      return { id: card.id, created: true, warnings }
    }
    this.touch(existing)
    Object.assign(existing, body)
    if (existing.state !== state)
      this.setState(existing, { state }, caller.as ?? 'source', input.why ?? null)
    this.host.changed()
    return { id: existing.id, created: false, warnings }
  }

  update(caller: InboxCaller, key: string, patch: Partial<InboxCardInput>): { warnings: string[] } {
    this.source(caller)
    const card = this.find(caller, key)
    if (!card) fail(`you have no card with key ${key}`)
    if (card.state === 'closed') fail('the card is already closed')
    if ('state' in patch) fail('use move to change the state')
    const keys: (keyof InboxCardBody)[] = [
      'title',
      'status',
      'level',
      'where',
      'session',
      'happenedAt',
      'blocks',
      'suggestion',
      'actions',
      'links'
    ]
    const merged: InboxCardInput = { key, title: card.title, level: card.level }
    for (const k of keys) (merged as Record<string, unknown>)[k] = card[k]
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'key') continue
      if (!keys.includes(k as keyof InboxCardBody)) fail(`${k} is not a field you can change`)
      ;(merged as Record<string, unknown>)[k] = v === null ? undefined : v
    }
    const warnings: string[] = []
    const body = checkCardBody(merged, warnings)
    this.touch(card)
    Object.assign(card, body)
    this.host.changed()
    return { warnings }
  }

  move(caller: InboxCaller, key: string, to: InboxTarget | string, why?: string): void {
    const t = checkTargetInput(to)
    const own = this.find(caller, key)
    const handed = caller.as
      ? this.all().find(
          (c) => c.key === key && c.state !== 'closed' && c.grants.some((g) => g.to === caller.as)
        )
      : undefined
    const card = own && own.state !== 'closed' ? own : (handed ?? own)
    if (!card) fail(`you have no card with key ${key}`)
    const granted = card.grants.some((g) => g.to === caller.as && g.states.includes(t.state))
    if (card !== own && !granted) fail('this card is not yours, and nobody let you move it there')
    if (card.state === 'closed') fail('the card is already closed')
    this.touch(card)
    this.setState(card, t, caller.as ?? 'source', why ?? null)
    this.host.changed()
  }

  delete(caller: InboxCaller, key: string): void {
    this.source(caller)
    const card = this.find(caller, key)
    if (!card) fail(`you have no card with key ${key}`)
    this.cancelPress(card, null)
    this.cards.delete(card.id)
    this.host.changed()
  }

  list(caller: InboxCaller, state?: InboxState): InboxCard[] {
    const source = this.source(caller)
    return this.all().filter(
      (c) =>
        c.source === source.id &&
        (!state || c.state === state) &&
        c.postedBy === (caller.as ?? null)
    )
  }

  private touch(card: InboxCard): void {
    if (card.press && card.press.step !== 'working')
      this.cancelPress(card, {
        kind: 'changed',
        text: 'This card just changed, so your press was not sent — have another look'
      })
  }

  private setState(card: InboxCard, t: InboxTarget, by: string, why: string | null): void {
    const now = this.host.now()
    card.history = [
      { at: now, from: card.state, to: t.state, status: t.status ?? card.status, by, why },
      ...card.history
    ].slice(0, 20)
    if (t.status) card.status = t.status
    if (card.state !== t.state) {
      card.state = t.state
      card.stateSince = now
    }
    if (t.state === 'closed') {
      card.closedAt = now
      card.closedBy = by
      card.grants = []
    }
  }

  dismiss(cardId: string): void {
    const card = this.cards.get(cardId)
    if (!card || card.state === 'closed' || card.press) return
    this.setState(card, { state: 'closed', status: 'Dismissed' }, 'you', null)
    this.host.changed()
  }

  setYourLevel(cardId: string, level: InboxLevel | null): void {
    const card = this.cards.get(cardId)
    if (!card) return
    card.yourLevel = level && level !== card.level ? level : null
    this.host.changed()
  }

  moveToTop(cardId: string): void {
    const card = this.cards.get(cardId)
    if (!card) return
    card.movedToTopAt = this.host.now()
    this.host.changed()
  }

  clearNotes(): void {
    for (const c of this.cards.values())
      if (c.note?.kind === 'changed' || (c.note?.kind === 'result' && !c.note.retry)) c.note = null
    this.host.changed()
  }

  press(
    cardId: string,
    actionId: string,
    answers: InboxAnswers,
    opts: { retry?: boolean } = {}
  ): void {
    const card = this.cards.get(cardId)
    if (!card) fail('no such card')
    if (!this.isReady(card.source)) fail('this source is not ready yet')
    if (card.press) fail('this card is busy with another press')
    const action = visibleActions(card).find((a) => a.id === actionId)
    if (!action) fail(`button ${actionId} is not on this card now`)
    const taken: InboxAnswers = {}
    for (const id of action.takes ?? []) if (answers[id] !== undefined) taken[id] = answers[id]
    if (!answersComplete(card, action, taken)) fail('answer every question first')
    const tries = opts.retry && card.lastPress?.action === actionId ? card.lastPress.try + 1 : 1
    card.note = null
    card.press = {
      action: actionId,
      step: action.style === 'danger' && !opts.retry ? 'confirm' : 'waiting',
      answers: taken,
      try: tries
    }
    if (card.press.step === 'waiting') this.startWait(card)
    this.host.changed()
  }

  confirm(cardId: string): void {
    const card = this.cards.get(cardId)
    if (card?.press?.step !== 'confirm') return
    card.press.step = 'waiting'
    this.startWait(card)
    this.host.changed()
  }

  undo(cardId: string): void {
    const card = this.cards.get(cardId)
    if (!card?.press || card.press.step === 'working') return
    this.cancelPress(card, null)
    this.host.changed()
  }

  retry(cardId: string): void {
    const card = this.cards.get(cardId)
    if (card?.lastPress)
      this.press(cardId, card.lastPress.action, card.lastPress.answers, { retry: true })
  }

  private startWait(card: InboxCard): void {
    if (!card.press) return
    card.press.until = this.host.now() + UNDO_MS
    this.timers.set(
      card.id,
      setTimeout(() => void this.fire(card.id), UNDO_MS)
    )
  }

  private cancelPress(card: InboxCard, note: InboxCard['note']): void {
    clearTimeout(this.timers.get(card.id))
    this.timers.delete(card.id)
    if (card.press?.step === 'working') return
    card.press = null
    if (note) card.note = note
  }

  private async fire(cardId: string): Promise<void> {
    this.timers.delete(cardId)
    const card = this.cards.get(cardId)
    if (card?.press?.step !== 'waiting') return
    const action = card.actions.find((a) => a.id === card.press?.action)
    if (!action) return
    const press = card.press
    press.step = 'working'
    card.lastPress = { action: action.id, answers: press.answers, try: press.try }
    this.host.changed()
    let result: Result
    try {
      result = await this.dispatch(card, action, press.answers)
    } catch (e) {
      result = { outcome: 'failed', text: `Koloft ran into an error: ${(e as Error).message}` }
    }
    if (this.cards.get(cardId) === card && card.press === press) this.finish(card, action, result)
  }

  private async dispatch(
    card: InboxCard,
    action: InboxAction,
    answers: InboxAnswers
  ): Promise<Result> {
    const run = action.run
    const wrap = (body: string): string =>
      `${envelopeHead(card, action)}\n${fillTemplate(body, card, answers)}\n${this.host.footer(card, action)}`
    if (run.type === 'session') {
      const to = run.session === CARD_SESSION ? card.session : run.session
      if (!to) return { outcome: 'failed', text: 'This card names no session' }
      if (run.answer) {
        const isBlock = card.blocks.some((b) => 'id' in b && b.id === run.answer)
        const r = await this.host.answerSession(
          to,
          isBlock ? { answers: answers[run.answer] } : { pick: run.answer }
        )
        if (r.elsewhere)
          return { outcome: 'elsewhere', text: r.why ?? 'It was already answered somewhere else' }
        if (!r.ok)
          return {
            outcome: 'failed',
            text: r.why ?? 'Koloft could not answer it',
            retryHelps: r.retryHelps
          }
        return { outcome: 'done', text: 'Answered — it is working again' }
      }
      const sent = await this.host.sendToSession(
        to,
        wrap(run.message ?? ''),
        goesToItsOwnSession(card, to)
      )
      if (!sent.ok)
        return { outcome: 'failed', text: sent.why ?? 'Koloft could not reach the session' }
      this.grant(card, action, sent.session ?? to)
      return { outcome: 'done', text: sent.text ?? 'Sent to the session' }
    }
    const cardId = card.id
    const started = await this.host.startSession(
      { ...run, task: wrap(run.task) },
      card,
      (reply) => {
        const replied = this.cards.get(cardId)
        if (!replied) return
        replied.note = { kind: 'reply', text: reply }
        this.host.changed()
      }
    )
    if (!started.ok || !started.session)
      return { outcome: 'failed', text: started.why ?? 'Koloft could not start a session' }
    this.grant(card, action, started.session)
    const opened: InboxLink = {
      label: `Open “${started.name ?? 'new session'}”`,
      to: { type: 'session', session: started.session },
      auto: true
    }
    card.links = [...card.links.filter((l) => !l.auto), opened].slice(-INBOX_LIMIT.links)
    return { outcome: 'done', text: `Started “${started.name ?? 'a new session'}”` }
  }

  private grant(card: InboxCard, action: InboxAction, session: string): void {
    if (action.lets?.length)
      card.grants = [
        ...card.grants.filter((g) => g.to !== session),
        { to: session, states: action.lets }
      ]
  }

  private finish(card: InboxCard, action: InboxAction, result: Result): void {
    const { outcome } = result
    card.press = null
    card.note = {
      kind: 'result',
      outcome,
      text: result.text,
      retry: outcome === 'failed' && result.retryHelps !== false
    }
    const t = action.then?.[outcome]
    if (t && card.state !== 'closed' && (t.state !== card.state || t.status))
      this.setState(card, t, action.id, null)
    this.host.changed()
  }

  rekeySession(from: string, to: string): void {
    let moved = 0
    const swap = (ref: string): string => (ref === from ? (moved++, to) : ref)
    for (const c of this.cards.values()) {
      if (c.session) c.session = swap(c.session)
      if (c.postedBy) c.postedBy = swap(c.postedBy)
      for (const g of c.grants) g.to = swap(g.to)
      for (const l of c.links)
        if ('session' in l.to) l.to = { ...l.to, session: swap(l.to.session) }
    }
    if (moved) this.host.changed()
  }
}
