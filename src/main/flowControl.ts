export const FLOW_SEND_HIGH = 512 * 1024
export const FLOW_SEND_LOW = 128 * 1024
// PLATFORM§21
export const FLOW_QUEUE_PAUSE = 8 * 1024 * 1024
export const FLOW_QUEUE_RESUME = 2 * 1024 * 1024
export const FLOW_SLICE_UTF16_UNITS = 128 * 1024
export const PTY_OUTPUT_COALESCE_ONE_FRAME_MS = 16
export const PTY_OUTPUT_COALESCE_OFF_SCREEN_MS = 200

import type { FlowStats } from '@shared/types'
import { endsMidPair } from '@shared/utf16'

export interface FlowGateCallbacks {
  onPause(): void
  onResume(): void
}

// PLATFORM§5 PLATFORM§29
export class FlowGate {
  private inflight = 0
  private blocked = false
  private paused = false
  private attached = false
  private sentTotal = 0
  private ackedTotal = 0

  constructor(
    private readonly cb: FlowGateCallbacks,
    private readonly sendHigh = FLOW_SEND_HIGH,
    private readonly sendLow = FLOW_SEND_LOW,
    private readonly queuePause = FLOW_QUEUE_PAUSE,
    private readonly queueResume = FLOW_QUEUE_RESUME
  ) {}

  maySend(): boolean {
    return this.attached && !this.blocked
  }

  isAttached(): boolean {
    return this.attached
  }

  onForwarded(utf16Units: number): void {
    this.sentTotal += utf16Units
    this.inflight += utf16Units
    if (!this.blocked && this.inflight > this.sendHigh) this.blocked = true
  }

  onAck(utf16Units: number): boolean {
    this.ackedTotal += utf16Units
    this.inflight = Math.max(0, this.inflight - utf16Units)
    if (this.blocked && this.inflight < this.sendLow) {
      this.blocked = false
      return true
    }
    return false
  }

  onBacklog(utf16Units: number): void {
    if (!this.paused && utf16Units > this.queuePause) {
      this.paused = true
      this.cb.onPause()
    } else if (this.paused && utf16Units < this.queueResume) {
      this.paused = false
      this.cb.onResume()
    }
  }

  attach(): void {
    this.attached = true
    this.inflight = 0
    this.blocked = false
  }

  reset(): void {
    this.attached = false
    this.inflight = 0
    this.blocked = false
    if (this.paused) {
      this.paused = false
      this.cb.onResume()
    }
  }

  stats(tabId: string): FlowStats {
    return {
      tabId,
      sentUnits: this.sentTotal,
      ackedUnits: this.ackedTotal,
      blocked: this.blocked,
      paused: this.paused,
      inflight: this.inflight,
      attached: this.attached
    }
  }
}

export const HELD_FOR_AN_UNSEEN_TAB_MAX = 1024 * 1024

export function nextSlice(data: string, maxUnits = FLOW_SLICE_UTF16_UNITS): string {
  if (data.length <= maxUnits) return data
  return data.slice(0, endsMidPair(data, maxUnits) ? maxUnits - 1 : maxUnits)
}

// PLATFORM§21
const QUESTION_FOR_THE_TERMINAL =
  /\x1b\[(?:[?>=]?[\d;]*[cn]|\??[\d;]*\$p|>[\d;]*q|\?u|(?:1[1-9]|2[01])(?:;[\d;]*)?t)|\x1b\]\d+;(?:[^\x07\x1b]*;)?\?(?:\x07|\x1b\\)|\x1bP[$+]q/

const QUESTION_START_KEPT_FROM_THE_LAST_READ = 12

export function asksTheTerminal(data: string): boolean {
  return QUESTION_FOR_THE_TERMINAL.test(data)
}

interface TabOutput {
  chunks: string[]
  units: number
  lastSentAt: number
  timer: ReturnType<typeof setTimeout> | null
  readTail: string
}

function takeSlice(tab: TabOutput): string {
  let whole = 0
  let units = 0
  while (whole < tab.chunks.length && units + tab.chunks[whole].length <= FLOW_SLICE_UTF16_UNITS)
    units += tab.chunks[whole++].length
  let slice = tab.chunks.splice(0, whole).join('')
  if (tab.chunks.length && units < FLOW_SLICE_UTF16_UNITS) {
    const head = tab.chunks[0]
    const part = nextSlice(head, FLOW_SLICE_UTF16_UNITS - units)
    slice += part
    tab.chunks[0] = head.slice(part.length)
  }
  tab.units -= slice.length
  return slice
}

export interface TerminalOutputDeps {
  pause(id: string): void
  resume(id: string): void
  send(id: string, data: string): boolean
  rendererUp(): boolean
  now(): number
}

export class TerminalOutput {
  private readonly tabs = new Map<string, TabOutput>()
  private readonly gates = new Map<string, FlowGate>()
  private readonly offScreen = new Set<string>()

  constructor(private readonly d: TerminalOutputDeps) {}

  attach(id: string): void {
    this.gate(id).attach()
    this.wake(id)
  }

  isAttached(id: string): boolean {
    return !!this.gates.get(id)?.isAttached()
  }

  ack(id: string, utf16Units: unknown): void {
    if (typeof utf16Units !== 'number' || !Number.isFinite(utf16Units) || utf16Units <= 0) return
    if (this.gates.get(id)?.onAck(utf16Units)) this.wake(id)
  }

  stats(): FlowStats[] {
    return [...this.gates.entries()].map(([id, gate]) => gate.stats(id))
  }

  push(id: string, data: string): void {
    if (!this.d.rendererUp()) return
    let tab = this.tabs.get(id)
    if (!tab) {
      tab = { chunks: [], units: 0, lastSentAt: -Infinity, timer: null, readTail: '' }
      this.tabs.set(id, tab)
    }
    tab.chunks.push(data)
    tab.units += data.length
    const offScreen = this.offScreen.has(id)
    if (offScreen) {
      const kept = QUESTION_START_KEPT_FROM_THE_LAST_READ
      const asks = asksTheTerminal(tab.readTail + data.slice(0, kept)) || asksTheTerminal(data)
      tab.readTail = asks
        ? ''
        : data.length >= kept
          ? data.slice(-kept)
          : (tab.readTail + data).slice(-kept)
      if (asks || tab.units >= FLOW_SLICE_UTF16_UNITS) return this.restart(id, true)
    }
    if (tab.timer) return
    const every = offScreen ? PTY_OUTPUT_COALESCE_OFF_SCREEN_MS : PTY_OUTPUT_COALESCE_ONE_FRAME_MS
    const sinceSent = this.d.now() - tab.lastSentAt
    if (sinceSent >= every) this.sendSlice(id, tab)
    else this.schedule(id, tab, every - sinceSent)
  }

  onScreen(id: string, shown: boolean): void {
    if (!shown) return void this.offScreen.add(id)
    if (this.offScreen.delete(id)) this.flush(id)
  }

  flush(id: string): void {
    this.restart(id, true)
  }

  end(id: string, showTheRest: boolean): void {
    this.drop(id, showTheRest)
    this.gates.get(id)?.reset()
    this.gates.delete(id)
  }

  clear(): void {
    for (const tab of this.tabs.values()) if (tab.timer) clearTimeout(tab.timer)
    this.tabs.clear()
    for (const gate of this.gates.values()) gate.reset()
    this.gates.clear()
    this.offScreen.clear()
  }

  private gate(id: string): FlowGate {
    let gate = this.gates.get(id)
    if (!gate) {
      gate = new FlowGate({ onPause: () => this.d.pause(id), onResume: () => this.d.resume(id) })
      this.gates.set(id, gate)
    }
    return gate
  }

  private wake(id: string): void {
    this.restart(id, false)
  }

  private restart(id: string, now: boolean): void {
    const tab = this.tabs.get(id)
    if (!tab?.units) return
    if (tab.timer) clearTimeout(tab.timer)
    tab.timer = null
    if (now) this.sendSlice(id, tab)
    else this.schedule(id, tab, 0)
  }

  private drop(id: string, showTheRest: boolean): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    if (tab.timer) clearTimeout(tab.timer)
    this.tabs.delete(id)
    while (showTheRest && tab.units) this.d.send(id, takeSlice(tab))
  }

  private schedule(id: string, tab: TabOutput, ms: number): void {
    tab.timer = setTimeout(() => {
      tab.timer = null
      this.sendSlice(id, tab)
    }, ms)
  }

  private sendSlice(id: string, tab: TabOutput): void {
    const gate = this.gate(id)
    if (!gate.maySend()) {
      if (gate.isAttached()) gate.onBacklog(tab.units)
      else while (tab.units > HELD_FOR_AN_UNSEEN_TAB_MAX) tab.units -= tab.chunks.shift()!.length
      return
    }
    const slice = takeSlice(tab)
    if (!this.d.send(id, slice)) {
      gate.reset()
      this.drop(id, false)
      return
    }
    tab.lastSentAt = this.d.now()
    gate.onForwarded(slice.length)
    gate.onBacklog(tab.units)
    if (tab.units && gate.maySend()) this.schedule(id, tab, 0)
  }
}
