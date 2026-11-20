import fs from 'fs'
import path from 'path'
import type { BackendId, SessionStatus } from '@shared/types'
import { composePrompt } from '@core/prompt'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import type { AskPayload } from '@shared/sessionEvent'
import { watchJsonDrops, writeWholeBeforeVisible } from '../../../main/jsonDrops'
import type { ToolCall } from './sessionTracker'
import {
  A_TAKEN_ANSWER_SHOWS_WITHIN_MS,
  ANSWER_NOT_TAKEN,
  answerKeys,
  ANSWER_KEYS,
  cannotAnswer,
  claudeDialog,
  claudeKeysFor,
  claudeResultComesAtOnce,
  codexKeyFor,
  hookAnswer,
  howToAnswer,
  isAskedCall,
  questionAnswers,
  takesSeveralPicks,
  type AnswerKeys,
  type SentAnswer,
  type CodexApproval,
  type CodexQuestion,
  type DialogView
} from './dialog'

export const CODEX_NEEDS_YES_OR_NO = 'Reply yes or no.'
export const SHOWS_NO_DIALOG = 'Koloft sees no question or approval in it right now.'
export const ANSWER_ON_ITS_WAY =
  'Koloft sent it an answer a moment ago and is waiting to see the session take it. Try again in a few seconds.'
const whoElseAnswers = (question: string, byTheOverseer: boolean): string =>
  byTheOverseer
    ? ''
    : composePrompt('session-answered-by-keys', { values: { 'the-question': question } })
// MUSE§3
export const asksWhatKoloftCannotSee = (byTheOverseer = false): string =>
  `It is waiting for an answer Koloft cannot read from here.${whoElseAnswers('it', byTheOverseer)}`
export const inputNotProbed = (label: string, byTheOverseer = false): string =>
  `${label} is asking something Koloft cannot answer from here: it answers a yes-or-no approval, or questions that each pick an option from a list.${whoElseAnswers('this one', byTheOverseer)}`
const takesYesOrNo = (label: string): string => `a ${label} approval takes yes or no.`
const NOT_ANSWERED_FROM_HERE = ''
export const STARTED_IN_THE_TERMINAL =
  'You already started on this question in the terminal, so Koloft leaves it to you there.'
export const PICKS_MAY_STILL_BE_TICKED =
  'Koloft already pressed picks into this question and the session did not take them, so some may still be ticked. Koloft leaves it to you in the terminal.'

export const answerKeysOf = (backend: BackendId | undefined): AnswerKeys | undefined =>
  backend && backend !== 'claude' ? ANSWER_KEYS[backend] : undefined

// MUSE§7 AGY§15
const TYPED_INTO_WHILE_WORKING: Record<BackendId, boolean> = {
  claude: true,
  codex: true,
  muse: false,
  agy: true
}
const typedIntoWhileWorking = (backend: BackendId | undefined): boolean =>
  !backend || TYPED_INTO_WHILE_WORKING[backend]
const ASK_SUFFIX = '.ask.json'
const ANSWER_SUFFIX = '.answer.json'

export interface SessionAskDeps {
  showsPromptBeforeBind(tabId: string): boolean
  boundKey(tabId: string): string | undefined
  queueDrained(tabId: string): boolean
  backendOf(tabId: string): BackendId | undefined
  status(tabId: string): SessionStatus | undefined
  awaitsInput(tabId: string): boolean
  turnOver(tabId: string): boolean
  type(tabId: string, keys: string[], stillWanted?: () => boolean): Promise<boolean>
  touchedSinceAsked(tabId: string): boolean
  ownerTouchedSince(tabId: string, at: number): boolean
  pendingApproval(tabId: string): CodexApproval | undefined
  pendingQuestion(tabId: string): CodexQuestion | undefined
  answerable(tabId: string): Promise<void>
  answerInPlace(tabId: string, reply: string): Promise<SentAnswer | false>
  showsDialogsClosing(tabId: string): boolean
  regDir: string
}

export interface AskListener {
  asksChanged?(tabId: string): void
  asked?(tabId: string, payload: AskPayload): void
  answered?(tabId: string, reply: string): void
  answerGoingIn?(tabId: string): void
}

export interface AnswerReader {
  toItsCard?: boolean
  byTheOverseer?: boolean
}

interface KeysTyped {
  at?: number
}

interface OpenClaudeAsk {
  payload: AskPayload
  hook?: string
  raw: string
  at: number
  typedAt?: number
  typing?: boolean
  keysSent?: boolean
}

export class SessionAsks {
  private asks = new Map<string, OpenClaudeAsk>()
  private askHooks = new Map<string, Set<string>>()
  private codexTyped = new Map<string, KeysTyped>()
  private ticksPressed = new Map<string, { ticks: string; untickedOnce: boolean }>()
  private awaitingTaken = new Map<string, Set<(taken: boolean) => void>>()
  private listeners: AskListener[] = []

  constructor(private d: SessionAskDeps) {}

  listen(listener: AskListener): void {
    this.listeners.push(listener)
  }

  private emit<K extends keyof AskListener>(
    moment: K,
    ...args: Parameters<NonNullable<AskListener[K]>>
  ): void {
    for (const l of this.listeners)
      (l[moment] as ((...a: typeof args) => void) | undefined)?.(...args)
  }

  dialogOpen(tab: string): boolean {
    return !!this.openAsk(tab) || !!this.d.pendingApproval(tab) || !!this.d.pendingQuestion(tab)
  }

  // AGY§8
  typable(tab: string): boolean {
    if (this.d.showsPromptBeforeBind(tab)) return true
    const status = this.d.status(tab)
    return (
      !!this.d.boundKey(tab) &&
      status !== undefined &&
      status !== 'approval' &&
      !(status === 'working' && !typedIntoWhileWorking(this.d.backendOf(tab))) &&
      !this.hookWaits(tab)
    )
  }

  // AGY§8
  takesCommand(tab: string): boolean {
    return (
      this.d.showsPromptBeforeBind(tab) ||
      (this.typable(tab) &&
        this.d.turnOver(tab) &&
        !this.dialogOpen(tab) &&
        this.d.queueDrained(tab))
    )
  }

  private hookWaits(tab: string): boolean {
    const hooks = this.askHooks.get(tab)
    if (!hooks) return false
    for (const hook of hooks)
      if (!fs.existsSync(this.hookFile(tab, hook, ASK_SUFFIX))) hooks.delete(hook)
    return hooks.size > 0
  }

  private hookFile(tab: string, hook: string, suffix: string): string {
    return path.join(this.d.regDir, `${tab}.${hook}${suffix}`)
  }

  private openAsk(tab: string): OpenClaudeAsk | undefined {
    const ask = this.asks.get(tab)
    if (!ask?.hook) return ask
    return fs.existsSync(this.hookFile(tab, ask.hook, ASK_SUFFIX)) ? ask : undefined
  }

  // CC§14
  watchAsks(): fs.FSWatcher | null {
    return watchJsonDrops(this.d.regDir, (name) => {
      if (!name.endsWith(ASK_SUFFIX)) return null
      const [tab, hook] = name.slice(0, -ASK_SUFFIX.length).split('.')
      if (!hook) return null
      if (fs.existsSync(path.join(this.d.regDir, name)))
        return (obj): void => this.onAsk(tab, obj as AskPayload, hook)
      if (this.askHooks.get(tab)?.delete(hook)) this.emit('asksChanged', tab)
      return null
    })
  }

  onAsk(tab: string, payload: AskPayload, hook?: string): void {
    const raw = JSON.stringify(payload)
    const before = this.asks.get(tab)
    const same = before && before.hook === hook && before.raw === raw
    if (same && (before.typedAt === undefined || before.typing)) return
    if (before?.hook && before.hook !== hook) this.release(tab, before.hook)
    this.asks.set(tab, { payload, hook, raw, at: Date.now() })
    if (hook) this.askHooks.set(tab, (this.askHooks.get(tab) ?? new Set()).add(hook))
    this.emit('asksChanged', tab)
    this.emit('asked', tab, payload)
  }

  stillAsks(tab: string): () => boolean {
    const ask = this.asks.get(tab)
    return () => !!ask && this.openAsk(tab) === ask
  }

  // CC§14
  claudeAskAnswerable(tab: string): boolean {
    const ask = this.openAsk(tab)
    return !!ask && (!!ask.hook || !(this.d.turnOver(tab) && !this.d.awaitsInput(tab)))
  }

  dropClaudeAsk(tab: string): void {
    this.asks.delete(tab)
  }

  dialog(tab: string): DialogView | undefined {
    const ask = this.openAsk(tab)
    return ask && claudeDialog(ask.payload)
  }

  askOf(tab: string): AskPayload | undefined {
    return this.openAsk(tab)?.payload
  }

  heldAsk(tab: string): AskPayload | undefined {
    const ask = this.openAsk(tab)
    return ask?.hook ? ask.payload : undefined
  }

  private release(tab: string, hook: string, output: unknown = {}): void {
    if (!fs.existsSync(this.hookFile(tab, hook, ASK_SUFFIX))) return
    try {
      writeWholeBeforeVisible(this.hookFile(tab, hook, ANSWER_SUFFIX), JSON.stringify(output))
    } catch {}
  }

  private answer(tab: string, output: unknown): void {
    const hook = this.asks.get(tab)?.hook
    this.asks.delete(tab)
    if (hook) this.release(tab, hook, output)
  }

  // CC§14
  toolDone(tab: string, call: ToolCall): void {
    const ask = this.asks.get(tab)
    if (ask && isAskedCall(ask.payload, call)) this.answer(tab, {})
  }

  private async press(tab: string, keys: string[], stillWanted?: () => boolean): Promise<boolean> {
    this.emit('answerGoingIn', tab)
    await this.d.answerable(tab)
    return this.d.type(tab, keys, stillWanted)
  }

  // CODEX§20 MUSE§11 AGY§14
  private pressAnswer(tab: string, keys: string[]): Promise<boolean> {
    return this.press(tab, keys, () => !this.d.touchedSinceAsked(tab))
  }

  private codexOnItsWay(tab: string): boolean {
    const typed = this.codexTyped.get(tab)
    if (!typed) return false
    return typed.at === undefined || Date.now() - typed.at < A_TAKEN_ANSWER_SHOWS_WITHIN_MS
  }

  private async pressOnce(tab: string, press: () => Promise<boolean>): Promise<boolean> {
    const typed: KeysTyped = {}
    this.codexTyped.set(tab, typed)
    const ours = (): boolean => this.codexTyped.get(tab) === typed
    try {
      const pressed = await press()
      if (pressed) typed.at = Date.now()
      else if (ours()) this.codexTyped.delete(tab)
      return pressed
    } catch (error) {
      if (ours()) this.codexTyped.delete(tab)
      throw error
    }
  }

  answerSession(
    tab: string,
    reply: string,
    { toItsCard = false, byTheOverseer = false }: AnswerReader = {}
  ): Promise<string | undefined> {
    return this.answerTaken(tab, () => this.sendAnswer(tab, reply, toItsCard, byTheOverseer))
  }

  // CC§14 CODEX§3 MUSE§11 AGY§14
  private async answerTaken(
    tab: string,
    send: () => Promise<SentAnswer>
  ): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let resolve!: (taken: boolean) => void
    const took = new Promise<boolean>((r) => (resolve = r))
    const waiting = this.awaitingTaken.get(tab) ?? new Set()
    const settle = (taken: boolean): void => {
      clearTimeout(timer)
      waiting.delete(settle)
      if (!waiting.size && this.awaitingTaken.get(tab) === waiting) this.awaitingTaken.delete(tab)
      resolve(taken)
    }
    this.awaitingTaken.set(tab, waiting.add(settle))
    const sent = await send().catch((e: unknown) => {
      settle(false)
      throw e
    })
    if (sent.error !== undefined || !sent.watch) {
      settle(sent.error === undefined)
      return sent.error
    }
    if (waiting.has(settle)) timer = setTimeout(() => settle(false), A_TAKEN_ANSWER_SHOWS_WITHIN_MS)
    return (await took) ? undefined : ANSWER_NOT_TAKEN
  }

  private async sendAnswer(
    tab: string,
    reply: string,
    toItsCard: boolean,
    byTheOverseer: boolean
  ): Promise<SentAnswer> {
    const backend = this.d.backendOf(tab)
    const answerKeysFor = answerKeysOf(backend)
    if (backend && answerKeysFor) {
      if (this.codexOnItsWay(tab)) return { error: ANSWER_ON_ITS_WAY }
      const inPlace = await this.d.answerInPlace(tab, reply)
      if (inPlace !== false) {
        this.emit('answerGoingIn', tab)
        if (inPlace.error === undefined) this.emit('answered', tab, reply)
        return inPlace
      }
      const label = BACKEND_LABEL[backend]
      const approval = this.d.pendingApproval(tab)
      if (approval) {
        const key = codexKeyFor(reply)
        if (!key) return { error: toItsCard ? CODEX_NEEDS_YES_OR_NO : takesYesOrNo(label) }
        if (this.codexOnItsWay(tab)) return { error: ANSWER_ON_ITS_WAY }
        this.emit('answered', tab, reply)
        await this.pressOnce(tab, () => this.press(tab, [key]))
        return { watch: true }
      }
      const question = this.d.pendingQuestion(tab)
      if (!question)
        return {
          error: this.d.awaitsInput(tab) ? inputNotProbed(label, byTheOverseer) : SHOWS_NO_DIALOG
        }
      const answers = questionAnswers(question, reply)
      if (!answers) return { error: toItsCard ? cannotAnswer(question) : howToAnswer(question) }
      // CODEX§20 MUSE§11 AGY§14
      if (this.d.touchedSinceAsked(tab)) return { error: STARTED_IN_THE_TERMINAL }
      if (this.codexOnItsWay(tab)) return { error: ANSWER_ON_ITS_WAY }
      // MUSE§11 AGY§14
      const ticks = question.questions.some((q) => q.multiSelect)
        ? JSON.stringify(question.questions)
        : undefined
      const before = ticks === undefined ? undefined : this.ticksPressed.get(tab)
      const pressedBefore = before !== undefined && before.ticks === ticks
      const untick =
        pressedBefore && !before.untickedOnce ? answerKeysFor.untickAll?.(question) : undefined
      if (pressedBefore && !untick) return { error: PICKS_MAY_STILL_BE_TICKED }
      if (ticks !== undefined && (pressedBefore || answers.some((a) => 'picks' in a)))
        this.ticksPressed.set(tab, { ticks, untickedOnce: pressedBefore })
      this.emit('answered', tab, reply)
      const keys = [...(untick ?? []), ...answerKeys(answerKeysFor, question, answers)]
      if (await this.pressOnce(tab, () => this.pressAnswer(tab, keys))) return { watch: true }
      this.emit('answered', tab, NOT_ANSWERED_FROM_HERE)
      return { error: STARTED_IN_THE_TERMINAL }
    }
    const ask = this.openAsk(tab)
    if (!ask)
      return {
        error:
          this.d.status(tab) === 'approval' || this.d.awaitsInput(tab)
            ? asksWhatKoloftCannotSee(byTheOverseer)
            : SHOWS_NO_DIALOG
      }
    // CC§14
    if (ask.hook) {
      this.answer(tab, hookAnswer(ask.payload, reply))
      this.emit('answered', tab, reply)
      return {}
    }
    // CC§12
    const watch = claudeResultComesAtOnce(ask.payload, reply) || this.d.showsDialogsClosing(tab)
    if (this.d.turnOver(tab) && !this.d.awaitsInput(tab)) return { error: SHOWS_NO_DIALOG }
    const onItsWay =
      ask.typedAt !== undefined && Date.now() - ask.typedAt < A_TAKEN_ANSWER_SHOWS_WITHIN_MS
    if (ask.typing || onItsWay) return { error: ANSWER_ON_ITS_WAY }
    const ownerTouchedIt = this.d.ownerTouchedSince(tab, ask.at)
    const keys = claudeKeysFor(ask.payload, reply, ownerTouchedIt || !!ask.keysSent)
    if (!keys.ok) return { error: keys.error }
    // CC§14
    if (takesSeveralPicks(ask.payload) && ownerTouchedIt) return { error: STARTED_IN_THE_TERMINAL }
    ask.keysSent = true
    if (watch) ask.typedAt = Date.now()
    else this.asks.delete(tab)
    this.emit('answered', tab, reply)
    const startedAt = Date.now()
    // CC§14
    const stillWanted = watch
      ? (): boolean => this.asks.get(tab) === ask && !this.d.ownerTouchedSince(tab, startedAt)
      : undefined
    ask.typing = true
    try {
      if (!(await this.d.type(tab, keys.value, stillWanted))) {
        const open = this.asks.get(tab) === ask
        ask.typedAt = undefined
        this.emit('answered', tab, NOT_ANSWERED_FROM_HERE)
        return { error: open ? STARTED_IN_THE_TERMINAL : SHOWS_NO_DIALOG }
      }
    } catch (error) {
      ask.typedAt = undefined
      throw error
    } finally {
      ask.typing = false
    }
    if (watch) ask.typedAt = Date.now()
    return { watch }
  }

  dialogGone(tab: string, closed: boolean): void {
    for (const settle of this.awaitingTaken.get(tab) ?? []) settle(true)
    this.codexTyped.delete(tab)
    this.ticksPressed.delete(tab)
    const ask = this.asks.get(tab)
    if (ask && !ask.hook && (closed || ask.typedAt !== undefined)) this.asks.delete(tab)
  }

  forget(tab: string): void {
    for (const settle of this.awaitingTaken.get(tab) ?? []) settle(false)
    this.answer(tab, {})
    this.codexTyped.delete(tab)
    this.ticksPressed.delete(tab)
    this.askHooks.delete(tab)
  }
}
