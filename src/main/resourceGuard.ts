import type { MachineState } from '@shared/types'
import { MachineRoom, READ_THE_MACHINE_EVERY_MS, type MachineRoomDeps } from './machineRoom'
import { toolsOf, treesByTab, withDescendants, type TaggedProcess } from './machineTrees'

export interface ResourceGuardDeps extends MachineRoomDeps {
  koloftPid: number
  agentTabsOnThisMac(): string[]
  lookedAt(): string | null
  changed(state: MachineState): void
  readTrees(): Promise<TaggedProcess[]>
  giveWay(pid: number, on: boolean): Promise<void>
}

const TERMINAL_REPLIES_AND_KEYS_START_WITH = '\x1b'
const TASKPOLICY_RUNS_AT_ONCE = 8

export function ownerTyped(data: string): boolean {
  return data.length > 0 && !data.startsWith(TERMINAL_REPLIES_AND_KEYS_START_WITH)
}

type StartedAtByPid = Map<number, string>

// ADR-0042
export class ResourceGuard {
  readonly room: MachineRoom
  private ownerWantsAtFullSpeed = new Set<string>()
  private lowered = new Map<string, StartedAtByPid>()
  private memory: Record<string, number> = {}
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private quitting = false
  private oneAtATime: Promise<unknown> = Promise.resolve()
  private last = ''

  constructor(private d: ResourceGuardDeps) {
    this.room = new MachineRoom(d)
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), READ_THE_MACHINE_EVERY_MS)
    this.timer.unref?.()
  }

  async tick(): Promise<void> {
    if (this.ticking || this.quitting) return
    this.ticking = true
    try {
      await this.room.tick()
      await this.inTurn(
        () => (this.room.memoryStaysCritical ? this.lookAt() : this.calmDown()),
        undefined
      )
    } catch (err) {
      this.couldNotLook(err)
    } finally {
      this.ticking = false
    }
  }

  lookedAtChanged(): void {
    if (this.room.memoryStaysCritical) void this.inTurn(() => this.lookAt(), undefined)
  }

  free(tabId: string): Promise<boolean> {
    if (!this.room.memoryStaysCritical || this.ownerWantsAtFullSpeed.has(tabId))
      return Promise.resolve(false)
    this.ownerWantsAtFullSpeed.add(tabId)
    return this.inTurn(async () => {
      if (this.lowered.has(tabId)) await this.lift([tabId], await this.d.readTrees())
      this.push()
      return true
    }, false)
  }

  forget(tabId: string): void {
    this.ownerWantsAtFullSpeed.delete(tabId)
    if (!this.lowered.has(tabId)) return
    void this.inTurn(async () => {
      await this.lift([tabId], await this.d.readTrees())
      this.push()
    }, undefined)
  }

  liftAllBeforeQuitting(): void {
    this.quitting = true
    clearInterval(this.timer)
    for (const pids of this.lowered.values())
      for (const pid of pids.keys()) void this.d.giveWay(pid, false)
    void this.inTurn(
      async () => this.lift([...this.lowered.keys()], await this.d.readTrees()),
      undefined
    )
  }

  state(): MachineState {
    return {
      critical: this.room.memoryStaysCritical,
      slowed: [...this.lowered.keys()],
      memory: this.memory
    }
  }

  private couldNotLook(err: unknown): void {
    this.d.log(`[koloft] machine: could not look at the machine: ${String(err)}`)
  }

  private inTurn<T>(work: () => Promise<T>, ifItFails: T): Promise<T> {
    const done = this.oneAtATime.then(work).catch((err) => {
      this.couldNotLook(err)
      return ifItFails
    })
    this.oneAtATime = done
    return done
  }

  private keepsItsSpeed(tabId: string): boolean {
    return tabId === this.d.lookedAt() || this.ownerWantsAtFullSpeed.has(tabId)
  }

  private async lookAt(): Promise<void> {
    const rows = await this.d.readTrees()
    if (!rows.length || this.quitting) return
    const trees = treesByTab(rows)
    const startedAt = new Map(rows.map((p) => [p.pid, p.started]))
    this.memory = {}
    for (const [tab, members] of trees)
      this.memory[tab] = members.reduce((sum, p) => sum + p.rssBytes, 0)
    const givingWay = this.d.agentTabsOnThisMac().filter((tab) => !this.keepsItsSpeed(tab))
    await this.lift(
      [...this.lowered.keys()].filter((tab) => !givingWay.includes(tab)),
      rows
    )
    const newlyLowered: number[] = []
    for (const tab of givingWay) {
      const before = this.lowered.get(tab)
      const now: StartedAtByPid = new Map()
      for (const [pid, started] of before ?? [])
        if (startedAt.get(pid) === started) now.set(pid, started)
      for (const p of toolsOf(trees.get(tab) ?? [], this.d.koloftPid)) {
        if (!now.has(p.pid)) newlyLowered.push(p.pid)
        now.set(p.pid, p.started)
      }
      if (now.size) this.lowered.set(tab, now)
      else this.lowered.delete(tab)
    }
    await this.setEach(newlyLowered, true)
    this.push()
  }

  private async calmDown(): Promise<void> {
    this.memory = {}
    this.ownerWantsAtFullSpeed.clear()
    if (this.lowered.size) await this.lift([...this.lowered.keys()], await this.d.readTrees())
    this.push()
  }

  // PLATFORM§59
  private async lift(tabs: string[], rows: TaggedProcess[]): Promise<void> {
    if (!tabs.length) return
    const startedAt = new Map(rows.map((p) => [p.pid, p.started]))
    const stillThere = new Set<number>()
    for (const tab of tabs) {
      for (const [pid, started] of this.lowered.get(tab) ?? [])
        if (startedAt.get(pid) === started) stillThere.add(pid)
      this.lowered.delete(tab)
    }
    await this.setEach(withDescendants(rows, stillThere), false)
  }

  private async setEach(pids: number[], on: boolean): Promise<void> {
    for (let i = 0; i < pids.length; i += TASKPOLICY_RUNS_AT_ONCE)
      await Promise.all(
        pids.slice(i, i + TASKPOLICY_RUNS_AT_ONCE).map((pid) => this.d.giveWay(pid, on))
      )
  }

  private push(): void {
    const state = this.state()
    const text = JSON.stringify(state)
    if (text === this.last) return
    this.last = text
    this.d.changed(state)
  }
}
