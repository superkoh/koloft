import type { BackendId } from '@shared/types'
import type { Turn } from '@shared/turns'
import { waitingForAnswer } from '@shared/slashCommands'
import type { CommandOutput } from '../claudeCommandOutput'
import { sleep } from '../codexTransport'
import { errorText } from '../agentRequests'
import { accentOf, CONDUCTOR_ACCENT, type Card } from './cards'

export const WAITS_FOR_IDLE_MS = 10 * 60_000
export const NOTHING_CAME_BACK_MS = 8000
export const MORE_OUTPUT_SETTLES_MS = 1500
export const RESULT_WITHIN_MS = 10 * 60_000
const ESC = '\x1b'
const CLOSE_THE_COMMAND_MENU = ESC
const CLOSE_PAGER = 'q'
const TO_LINE_END = '\x05'
const CLEAR_TO_LINE_START = '\x15'
// CODEX§21
const CODEX_BACK_TO_AN_EMPTY_BOX = [ESC, CLOSE_PAGER, TO_LINE_END + CLEAR_TO_LINE_START]
// CC§11 CC§12
const PANEL_CLOSES_WITHIN_MS = 500
const ESC_PRESSES_AT_MOST = 3

export interface SlashTarget {
  name: string
  tabId: string
  conductor: boolean
}

export interface SlashDeps {
  backendOf(tabId: string): BackendId | undefined
  keyOf(tabId: string): string | undefined
  turnOver(tabId: string): boolean
  asking(tabId: string): boolean
  takesTyping(tabId: string): boolean
  panelOpen(tabId: string): Promise<boolean | undefined>
  nextMirrorPull(tabId: string): Promise<void> | undefined
  ready(tabId: string, ready: () => boolean, ms: number): Promise<boolean>
  exclusive(tabId: string, typing: () => Promise<boolean>): Promise<boolean>
  typeNow(tabId: string, keys: string[]): Promise<void>
  post(channelId: string, text: string): void
  card(channelId: string, card: Card): void
}

interface Pending {
  target: SlashTarget
  text: string
  channelId: string
  typedAt: number
  keyBefore?: string
  outputs: CommandOutput[]
  worked: boolean
  reply?: string
  newKey?: string
  pressedEsc: boolean
  timers: ReturnType<typeof setTimeout>[]
  settle?: ReturnType<typeof setTimeout>
  mirrorPull?: Promise<void>
}

// CC§12 CODEX§21
export function commandKeys(text: string, backend: BackendId | undefined): string[] {
  const typed = [text, CLOSE_THE_COMMAND_MENU, '\r']
  return backend === 'codex' ? [TO_LINE_END + CLEAR_TO_LINE_START, ...typed] : typed
}

function resultCard(p: Pending): Card | undefined {
  const details = p.outputs.filter((o) => o.kind === 'details').map((o) => o.text)
  const printed = p.outputs.filter((o) => o.kind !== 'details').map((o) => o.text)
  const said = details.length && !p.worked ? details : printed
  const body: string[] = []
  if (p.newKey) body.push(`It is a new conversation now, with the id ${p.newKey}.`)
  if (p.reply && !p.target.conductor) body.push(p.reply)
  else if (said.length) body.push(said.join('\n\n'))
  if (!body.length && p.reply) return undefined
  if (!body.length && p.worked) body.push('Done.')
  if (!body.length)
    body.push(
      'It printed nothing Koloft can read. Whatever it showed is only on its screen; ask the conductor to show you its screen.'
    )
  if (p.pressedEsc)
    body.push(
      `Nothing came back within ${NOTHING_CAME_BACK_MS / 1000} seconds, so Koloft pressed Esc to close any menu it had opened. A command that asks you to pick something needs its choice written after it, like /model haiku.`
    )
  return {
    accent: p.target.conductor ? CONDUCTOR_ACCENT : accentOf(p.target.name),
    header: `⌨️ **${p.target.name}** ran ${p.text}:`,
    body: body.join('\n\n')
  }
}

export class SlashCommands {
  private pending = new Map<string, Pending>()

  constructor(private d: SlashDeps) {}

  running(tab: string): boolean {
    return this.pending.has(tab)
  }

  run(target: SlashTarget, text: string, channelId: string): string {
    if (this.d.asking(target.tabId)) return waitingForAnswer(target.name, text)
    const ack = this.d.takesTyping(target.tabId)
      ? `Typing ${text} into ${target.name}; Koloft posts what it prints in Discord.`
      : `${target.name} is busy; Koloft will type ${text} once its turn ends, and post what it prints in Discord.`
    void this.typeWhenIdle(target, text, channelId).catch((error: unknown) =>
      this.d.post(channelId, `⚠ ${errorText(error)}`)
    )
    return ack
  }

  async typeWhenIdle(target: SlashTarget, text: string, channelId: string): Promise<void> {
    const tab = target.tabId
    const until = Date.now() + WAITS_FOR_IDLE_MS
    const idle = (): boolean => this.d.takesTyping(tab)
    for (;;) {
      if (this.d.asking(tab)) throw new Error(waitingForAnswer(target.name, text))
      if (!(await this.d.ready(tab, () => idle() || this.d.asking(tab), until - Date.now())))
        throw new Error(
          `${target.name} did not finish its turn within ${WAITS_FOR_IDLE_MS / 60_000} minutes, so ${text} was not typed.`
        )
      let panel = false
      const typed = await this.d.exclusive(tab, async () => {
        if (!idle()) return false
        panel = (await this.d.panelOpen(tab)) === true
        if (panel) return false
        this.arm(target, text, channelId)
        await this.d.typeNow(tab, commandKeys(text, this.d.backendOf(tab)))
        return true
      })
      if (typed) return
      if (panel)
        throw new Error(
          `${target.name} shows a menu or a panel at the Mac right now, so ${text} was not typed: it would land in that menu.`
        )
    }
  }

  private arm(target: SlashTarget, text: string, channelId: string): void {
    const tab = target.tabId
    this.finish(tab)
    const p: Pending = {
      target,
      text,
      channelId,
      typedAt: Date.now(),
      keyBefore: this.d.keyOf(tab),
      outputs: [],
      worked: false,
      pressedEsc: false,
      timers: []
    }
    p.timers.push(setTimeout(() => void this.nothingCameBack(tab, p), NOTHING_CAME_BACK_MS))
    p.timers.push(setTimeout(() => this.finish(tab), RESULT_WITHIN_MS))
    this.pending.set(tab, p)
  }

  private async nothingCameBack(tab: string, p: Pending): Promise<void> {
    const quiet = (): boolean =>
      this.pending.get(tab) === p &&
      !p.outputs.length &&
      !p.worked &&
      !p.newKey &&
      this.d.turnOver(tab)
    if (!quiet()) return
    let panel = await this.d.panelOpen(tab)
    if (!quiet()) return
    if (panel !== false) {
      p.pressedEsc = true
      const keys = this.d.backendOf(tab) === 'codex' ? CODEX_BACK_TO_AN_EMPTY_BOX : [ESC]
      await this.press(tab, keys)
    }
    for (let more = 1; panel && more < ESC_PRESSES_AT_MOST; more++) {
      await sleep(PANEL_CLOSES_WITHIN_MS)
      panel = await this.d.panelOpen(tab)
      if (panel) await this.press(tab, [ESC])
    }
    if (this.pending.get(tab) === p) this.settleSoon(tab, p)
  }

  private press(tab: string, keys: string[]): Promise<boolean> {
    return this.d.exclusive(tab, async () => {
      await this.d.typeNow(tab, keys)
      return true
    })
  }

  private settleSoon(tab: string, p: Pending): void {
    clearTimeout(p.settle)
    p.settle = setTimeout(() => {
      if (this.pending.get(tab) === p && !p.mirrorPull && this.d.turnOver(tab)) this.finish(tab)
    }, MORE_OUTPUT_SETTLES_MS)
  }

  private settleAfterMirrorPull(tab: string, p: Pending): void {
    const pull = this.d.nextMirrorPull(tab)
    p.mirrorPull = pull
    if (!pull) return this.settleSoon(tab, p)
    clearTimeout(p.settle)
    void pull.then(() => {
      if (p.mirrorPull !== pull) return
      p.mirrorPull = undefined
      if (this.pending.get(tab) === p) this.settleSoon(tab, p)
    })
  }

  output(tab: string, output: CommandOutput): void {
    const p = this.pending.get(tab)
    if (!p) return
    p.outputs.push(output)
    this.settleSoon(tab, p)
  }

  turnOver(tab: string, over: boolean): void {
    const p = this.pending.get(tab)
    if (!p) return
    if (!over) {
      p.worked = true
      clearTimeout(p.settle)
    } else if (p.worked) this.settleAfterMirrorPull(tab, p)
  }

  turnEnded(tab: string, turn: Turn): void {
    const p = this.pending.get(tab)
    if (p && turn.reply.trim() && turn.at >= p.typedAt) p.reply = turn.reply
  }

  bound(tab: string, key: string): void {
    const p = this.pending.get(tab)
    if (!p || key === p.keyBefore) return
    p.newKey = key
    this.settleSoon(tab, p)
  }

  closed(tab: string): void {
    const p = this.take(tab)
    if (p) this.d.post(p.channelId, `⌨️ ${p.target.name} closed before ${p.text} printed anything.`)
  }

  private finish(tab: string): void {
    const p = this.take(tab)
    const card = p && resultCard(p)
    if (p && card) this.d.card(p.channelId, card)
  }

  private take(tab: string): Pending | undefined {
    const p = this.pending.get(tab)
    if (!p) return undefined
    this.pending.delete(tab)
    for (const t of p.timers) clearTimeout(t)
    clearTimeout(p.settle)
    return p
  }
}
