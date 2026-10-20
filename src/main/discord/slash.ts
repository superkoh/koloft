import type { BackendId } from '@shared/types'
import type { Turn } from '@shared/turns'
import { waitingForAnswer } from '@shared/slashCommands'
import type { CommandOutput } from '../claudeCommandOutput'
import { sleep } from '../codexTransport'
import { errorText } from '../agentRequests'
import { withoutBlankEdges } from '../messageText'
import { codexComposerDraft, inputBoxDraft } from '../inputBox'
import { accentOf, CONDUCTOR_ACCENT, type Card } from './cards'

export const WAITS_FOR_IDLE_MS = 10 * 60_000
export const NOTHING_CAME_BACK_MS = 8000
export const MORE_OUTPUT_SETTLES_MS = 1500
// CC§2
export const A_CLAUDE_TURN_ENDS_AFTER_ITS_STOP_WITHIN_MS = 10_000
export const RESULT_WITHIN_MS = 10 * 60_000
const ESC = '\x1b'
const CLOSE_THE_COMMAND_MENU = ESC
const CLOSE_PAGER = 'q'
const TO_LINE_END = '\x05'
const CLEAR_TO_LINE_START = '\x15'
const EMPTY_THE_BOX = TO_LINE_END + CLEAR_TO_LINE_START
// CODEX§21
const BACK_TO_AN_EMPTY_BOX: Record<BackendId, string[]> = {
  claude: [ESC],
  codex: [ESC, CLOSE_PAGER, EMPTY_THE_BOX],
  muse: [ESC],
  agy: [ESC]
}
const BEFORE_A_COMMAND: Record<BackendId, string[]> = {
  claude: [],
  codex: [EMPTY_THE_BOX],
  muse: [],
  agy: []
}
// CC§12 AGY§23
const MENU_CLOSER: Record<BackendId, string[]> = {
  claude: [CLOSE_THE_COMMAND_MENU],
  codex: [CLOSE_THE_COMMAND_MENU],
  muse: [CLOSE_THE_COMMAND_MENU],
  agy: []
}
// CC§11 CC§12
const PANEL_CLOSES_WITHIN_MS = 500
const ESC_PRESSES_AT_MOST = 3
// AGY§23
export const SCREEN_SHOWS_THE_OUTPUT_MS = 1500
// CC§12 CODEX§21 MUSE§11
const DRAFT_ON_SCREEN: Partial<Record<BackendId, (lines: string[]) => string | undefined>> = {
  claude: inputBoxDraft,
  codex: codexComposerDraft,
  muse: inputBoxDraft
}
export const AN_ENTER_LANDS_WITHIN_MS = 2000

export interface SlashTarget {
  name: string
  tabId: string
  butler: boolean
}

export interface SlashDeps {
  backendOf(tabId: string): BackendId | undefined
  keyOf(tabId: string): string | undefined
  turnOver(tabId: string): boolean
  asking(tabId: string): boolean
  takesTyping(tabId: string): boolean
  panelOpen(tabId: string, screen?: string[]): Promise<boolean | undefined>
  screen(tabId: string): Promise<string[] | undefined>
  nextMirrorPull(tabId: string): Promise<void> | undefined
  ready(tabId: string, ready: () => boolean, ms: number): Promise<boolean>
  exclusive(tabId: string, typing: () => Promise<boolean>): Promise<boolean>
  typeNow(tabId: string, keys: string[]): Promise<void>
  outputOnlyOnScreen(tabId: string): Promise<string | undefined> | undefined
  post(to: SlashReplyTo, text: string): void
  card(to: SlashReplyTo, card: Card): void
}

export type SlashReplyTo = { channelId: string } | { tell(text: string): void }

export function replyWhere(to: SlashReplyTo): string {
  return 'channelId' in to ? 'post what it prints in Discord' : 'hand you what it prints'
}

interface Pending {
  target: SlashTarget
  text: string
  to: SlashReplyTo
  typedAt: number
  keyBefore?: string
  outputs: CommandOutput[]
  worked: boolean
  turnEnded: boolean
  reply?: string
  newKey?: string
  pressedEsc: boolean
  screen?: string[]
  timers: ReturnType<typeof setTimeout>[]
  settle?: ReturnType<typeof setTimeout>
  mirrorPull?: Promise<void>
}

// CC§12 CODEX§21 AGY§23
export function commandKeys(text: string, backend: BackendId | undefined): string[] {
  return [
    ...(backend ? BEFORE_A_COMMAND[backend] : []),
    text,
    ...(backend ? MENU_CLOSER[backend] : [CLOSE_THE_COMMAND_MENU]),
    '\r'
  ]
}

const SCREEN_LINES_IN_A_RESULT = 40

function screenShot(lines: string[] | undefined): string | undefined {
  const shown = withoutBlankEdges(lines ?? [])
  if (!shown.length) return undefined
  return `It printed nothing Koloft can read, so here is its screen:\n\`\`\`\n${shown.slice(-SCREEN_LINES_IN_A_RESULT).join('\n')}\n\`\`\``
}

function resultCard(p: Pending, screen: string[] | undefined): Card | undefined {
  const details = p.outputs.filter((o) => o.kind === 'details').map((o) => o.text)
  const printed = p.outputs.filter((o) => o.kind !== 'details').map((o) => o.text)
  const said = details.length && !p.worked ? details : printed
  const body: string[] = []
  if (p.newKey) body.push(`It is a new conversation now, with the id ${p.newKey}.`)
  if (p.reply && !p.target.butler) body.push(p.reply)
  else if (said.length) body.push(said.join('\n\n'))
  if (!body.length && p.reply) return undefined
  if (!body.length && p.worked) body.push('Done.')
  if (!body.length)
    body.push(
      screenShot(screen) ??
        'It printed nothing Koloft can read, and its screen could not be read either.'
    )
  if (p.pressedEsc)
    body.push(
      `Nothing came back within ${NOTHING_CAME_BACK_MS / 1000} seconds, so Koloft pressed Esc to close any menu it had opened. A command that asks you to pick something needs its choice written after it, like /model haiku.`
    )
  return {
    accent: p.target.butler ? CONDUCTOR_ACCENT : accentOf(p.target.name),
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

  run(target: SlashTarget, text: string, to: SlashReplyTo): string {
    if (this.d.asking(target.tabId)) return waitingForAnswer(target.name, text)
    const where = replyWhere(to)
    const ack = this.d.takesTyping(target.tabId)
      ? `Typing ${text} into ${target.name}; Koloft will ${where}.`
      : `${target.name} is busy; Koloft will type ${text} once its turn ends, and ${where}.`
    void this.typeWhenIdle(target, text, to).catch((error: unknown) =>
      this.d.post(to, `⚠ ${errorText(error)}`)
    )
    return ack
  }

  async typeWhenIdle(target: SlashTarget, text: string, to: SlashReplyTo): Promise<void> {
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
        const p = this.arm(target, text, to)
        await this.d.typeNow(tab, commandKeys(text, this.d.backendOf(tab)))
        this.checkTheEnterLanded(tab, p)
        return true
      })
      if (typed) return
      if (panel)
        throw new Error(
          `${target.name} shows a menu or a panel at the Mac right now, so ${text} was not typed: it would land in that menu.`
        )
    }
  }

  private arm(target: SlashTarget, text: string, to: SlashReplyTo): Pending {
    const tab = target.tabId
    this.finish(tab)
    const p: Pending = {
      target,
      text,
      to,
      typedAt: Date.now(),
      keyBefore: this.d.keyOf(tab),
      outputs: [],
      worked: false,
      turnEnded: false,
      pressedEsc: false,
      timers: []
    }
    p.timers.push(setTimeout(() => void this.nothingCameBack(tab, p), NOTHING_CAME_BACK_MS))
    p.timers.push(setTimeout(() => this.finish(tab), RESULT_WITHIN_MS))
    p.timers.push(setTimeout(() => void this.readScreen(tab, p), SCREEN_SHOWS_THE_OUTPUT_MS))
    this.pending.set(tab, p)
    return p
  }

  private unanswered(tab: string, p: Pending): boolean {
    return this.pending.get(tab) === p && !p.outputs.length && !p.worked && !p.newKey
  }

  // CC§12 CODEX§21 MUSE§11
  private checkTheEnterLanded(tab: string, p: Pending): void {
    const backend = this.d.backendOf(tab)
    const draft = backend && DRAFT_ON_SCREEN[backend]
    if (!draft) return
    const enterAgainIfStillTyped = async (): Promise<void> => {
      if (!this.unanswered(tab, p)) return
      const lines = await this.d.screen(tab).catch(() => undefined)
      if (lines && this.unanswered(tab, p) && draft(lines) === p.text.trim())
        await this.press(tab, ['\r'])
    }
    p.timers.push(setTimeout(() => void enterAgainIfStillTyped(), AN_ENTER_LANDS_WITHIN_MS))
  }

  // AGY§23
  private async readScreen(tab: string, p: Pending): Promise<void> {
    const reading = this.d.outputOnlyOnScreen(tab)
    if (!reading) return
    const text = await reading
    if (this.pending.get(tab) !== p || p.outputs.length || p.worked || !text) return
    p.outputs.push({ kind: 'printed', text })
    await this.press(tab, [ESC])
    this.settleSoon(tab, p)
  }

  private async nothingCameBack(tab: string, p: Pending): Promise<void> {
    const quiet = (): boolean => this.unanswered(tab, p) && this.d.turnOver(tab)
    if (!quiet()) return
    p.screen = await this.d.screen(tab).catch(() => undefined)
    let panel = await this.d.panelOpen(tab, p.screen)
    if (!quiet()) return
    if (panel !== false) {
      p.pressedEsc = true
      const backend = this.d.backendOf(tab)
      await this.press(tab, backend ? BACK_TO_AN_EMPTY_BOX[backend] : [ESC])
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

  private settleSoon(tab: string, p: Pending, ms = MORE_OUTPUT_SETTLES_MS): void {
    clearTimeout(p.settle)
    p.settle = setTimeout(() => {
      if (this.pending.get(tab) === p && !p.mirrorPull && this.d.turnOver(tab)) this.finish(tab)
    }, ms)
  }

  private settleOnceItsTurnEnds(tab: string, p: Pending): void {
    const waitsForTheTurnEnd =
      this.d.backendOf(tab) === 'claude' &&
      !p.turnEnded &&
      p.reply === undefined &&
      !p.outputs.length &&
      !p.newKey
    this.settleSoon(
      tab,
      p,
      waitsForTheTurnEnd ? A_CLAUDE_TURN_ENDS_AFTER_ITS_STOP_WITHIN_MS : MORE_OUTPUT_SETTLES_MS
    )
  }

  private settleAfterMirrorPull(tab: string, p: Pending): void {
    const pull = this.d.nextMirrorPull(tab)
    p.mirrorPull = pull
    if (!pull) return this.settleOnceItsTurnEnds(tab, p)
    void pull.then(() => {
      if (p.mirrorPull !== pull) return
      p.mirrorPull = undefined
      if (this.pending.get(tab) === p) this.settleOnceItsTurnEnds(tab, p)
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
    if (!p || turn.at < p.typedAt) return
    if (turn.reply.trim()) p.reply = turn.reply
    if (!p.worked) return
    p.turnEnded = true
    if (!p.mirrorPull) this.settleSoon(tab, p)
  }

  bound(tab: string, key: string): void {
    const p = this.pending.get(tab)
    if (!p || key === p.keyBefore) return
    p.newKey = key
    this.settleSoon(tab, p)
  }

  closed(tab: string): void {
    const p = this.take(tab)
    if (p) this.d.post(p.to, `⌨️ ${p.target.name} closed before ${p.text} printed anything.`)
  }

  private finish(tab: string): void {
    const p = this.take(tab)
    if (!p) return
    const readable = p.outputs.length > 0 || p.worked || !!p.reply || !!p.newKey
    const screen =
      readable || p.screen ? Promise.resolve(p.screen) : this.d.screen(tab).catch(() => undefined)
    void screen.then((lines) => {
      const card = resultCard(p, lines)
      if (card) this.d.card(p.to, card)
    })
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
