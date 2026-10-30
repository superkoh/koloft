import fs from 'fs'
import path from 'path'
import type { MachineState, HeldCommand, QueuedLaunch } from '@shared/types'
import { LaunchQueue, type InTurn } from './launchQueue'
import {
  BUSY_AT_LOAD_PER_CORE,
  BUSY_MARKER,
  GAP_AFTER_A_COMMAND_MS,
  MachineRoom,
  MEMORY_PRESSURE_WARNING,
  READ_THE_MACHINE_EVERY_MS,
  RELEASE_AFTER_FILE,
  type MachineRoomDeps
} from './machineRoom'
import { treesByTab, type TaggedProcess, type Trees } from './machineTrees'

const BACKGROUND_WORK_COUNTS_FROM_CPU_PERCENT = 100
const BACKGROUND_WORK_COUNTS_FROM_BYTES = 2 * 2 ** 30

export const HELD_SUFFIX = '.held'
export const FREE_SUFFIX = '.free'
export const HOLD_HOOK_TIMEOUT_S = 3600
export const HOLD_GIVES_UP_BEFORE_THE_HOOK_TIMEOUT_S = 3500
export const REMOTE_BUSY_BELOW_FREE_MEMORY_PERCENT = 10
const HOLD_LOOKS_AROUND_EVERY_S = 5
const RELEASE_CLAIM_SUFFIX = '.claim'
const HELD_FILE = /^(.+)\.\d+\.held$/
// CODEX§27 MUSE§9 AGY§13
const SHELL_TOOLS = ['Bash', 'bash', 'run_command']

// PLATFORM§59 ADR-0043
const HOLD_BRANCH = `  hold|hold-self)
    most="$(printf '%s' "$4" | tr -cd '0-9')"
    [ -f "$reg/$tab${FREE_SUFFIX}" ] && exit 0
    printf '%s' "$input" | grep -qE '"(tool_name|name)"[[:space:]]*:[[:space:]]*"(${SHELL_TOOLS.join('|')})"' || exit 0
    printf '%s' "$input" | grep -qE '"(command|CommandLine)"[[:space:]]*:[[:space:]]*"koloft( |")' && exit 0
    cores=""
    busy_here() {
      [ -n "$cores" ] || cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
      if [ -r /proc/loadavg ]; then load="$(cut -d' ' -f1 /proc/loadavg)"
      else load="$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}' | tr , .)"; fi
      pressure="$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || echo 1)"
      free="$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{if (t) print int(a*100/t); else print 100}' /proc/meminfo 2>/dev/null || echo 100)"
      awk -v l="$load" -v c="$cores" -v p="$pressure" -v f="$free" 'BEGIN{exit !(l >= ${BUSY_AT_LOAD_PER_CORE} * c || p >= ${MEMORY_PRESSURE_WARNING} || f < ${REMOTE_BUSY_BELOW_FREE_MEMORY_PERCENT})}'
    }
    busy() {
      if [ "$event" = "hold" ]; then [ -f "$reg/${BUSY_MARKER}" ]; else busy_here; fi
    }
    turn_now() {
      after="$(tr -cd '0-9' < "$reg/${RELEASE_AFTER_FILE}" 2>/dev/null)"
      [ "$1" -ge "\${after:-0}" ]
    }
    start="$(date +%s)"
    { ! busy && turn_now "$start"; } && exit 0
    mkdir -p "$reg" 2>/dev/null
    held="$reg/$tab.$$${HELD_SUFFIX}"; tick="$reg/$tab.$$.hold-tick"
    trap 'rm -f "$held" "$tick"' EXIT
    trap 'exit 143' TERM
    mkfifo "$tick" 2>/dev/null || exit 0
    cmd="$(printf '%s' "$input" | sed -n -E 's/.*"(command|CommandLine)"[[:space:]]*:[[:space:]]*"([^"]*)".*/\\2/p' | cut -c1-200)"
    printf '%s\\n%s\\n' "$start" "$cmd" > "$held"
    gp="$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d ' ')"
    began=$SECONDS
    n=0
    while :; do
      read -t 1 <> "$tick"
      n=$((n + 1))
      [ -f "$reg/$tab${FREE_SUFFIX}" ] && break
      now=$((start + SECONDS - began))
      [ $((now - start)) -ge "\${most:-${HOLD_GIVES_UP_BEFORE_THE_HOOK_TIMEOUT_S}}" ] && break
      [ $((n % ${HOLD_LOOKS_AROUND_EVERY_S})) -eq 0 ] || continue
      kill -0 "$PPID" 2>/dev/null || exit 0
      [ "$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d ' ')" = "$gp" ] || exit 0
      find "$reg" -maxdepth 1 -name 'release-*${RELEASE_CLAIM_SUFFIX}' -mmin +1 -exec rmdir {} + 2>/dev/null
      if ! busy && turn_now "$now" && mkdir "$reg/release-\${after:-0}${RELEASE_CLAIM_SUFFIX}" 2>/dev/null; then
        printf '%s\\n' "$((now + ${GAP_AFTER_A_COMMAND_MS / 1000}))" > "$reg/${RELEASE_AFTER_FILE}.$$"
        mv -f "$reg/${RELEASE_AFTER_FILE}.$$" "$reg/${RELEASE_AFTER_FILE}"
        break
      fi
    done
    ;;
`

// CODEX§30
export const CODEX_HOLDS_LESS_THAN_ITS_EXEC_WALL_S = 25

export const HOLD_SCRIPT = `#!/usr/bin/env bash
reg="$1"; tab="$2"; event="$3"
input="$(cat | tr -d '\\n')"
[ -z "$reg" ] && exit 0
[ -z "$tab" ] && exit 0
case "$event" in
${HOLD_BRANCH}esac
exit 0
`

export interface ResourceGuardDeps extends MachineRoomDeps {
  heldDirs(): string[]
  freeOnMachine(tabId: string): Promise<void>
  isRemote(tabId: string): boolean
  changed(state: MachineState): void
  readTrees(): Promise<TaggedProcess[]>
  giveWay(pid: number, on: boolean): Promise<void>
}

const TERMINAL_REPLIES_AND_KEYS_START_WITH = '\x1b'

export function ownerTyped(data: string): boolean {
  return data.length > 0 && !data.startsWith(TERMINAL_REPLIES_AND_KEYS_START_WITH)
}

function startedAtOnce(tabId: string, start: () => Promise<string | null>): InTurn {
  const started = start().catch(() => null)
  return {
    tabId,
    queued: false,
    started,
    outcome: started.then((id) => (id ? 'started' : 'failed'))
  }
}

export function parseHeld(text: string, nowMs: number): HeldCommand | undefined {
  const [sinceLine, ...rest] = text.split('\n')
  const since = Number(sinceLine.trim())
  if (!Number.isFinite(since) || since <= 0) return undefined
  return { since: Math.min(since * 1000, nowMs), command: rest.join('\n').trim() }
}

export class ResourceGuard {
  readonly room: MachineRoom
  readonly queue: LaunchQueue
  private background = new Set<string>()
  private held: Record<string, HeldCommand> = {}
  private memory: Record<string, number> = {}
  private sharedVmBytes = 0
  private yielded = new Map<string, Set<number>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private last = ''

  constructor(private d: ResourceGuardDeps) {
    this.room = new MachineRoom(d)
    this.queue = new LaunchQueue({ room: this.room, now: d.now, changed: () => this.push() })
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), READ_THE_MACHINE_EVERY_MS)
    this.timer.unref?.()
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.room.tick()
      if (this.room.busy) {
        const rows = await this.d.readTrees()
        if (rows.length) await this.lookAt(treesByTab(rows), new Set(rows.map((p) => p.pid)))
      } else await this.calmDown()
      this.queue.pump()
      this.held = this.readHeld()
      this.push()
    } catch (err) {
      this.d.log(`[koloft] machine: could not look at the machine: ${String(err)}`)
    } finally {
      this.ticking = false
    }
  }

  private async lookAt(trees: Trees, alive: Set<number>): Promise<void> {
    this.memory = {}
    for (const [tab, members] of trees.members)
      this.memory[tab] = members.reduce((sum, p) => sum + p.rssBytes, 0)
    this.sharedVmBytes = trees.sharedVmBytes
    let cpu = 0
    let bytes = 0
    const newlyLowered: number[] = []
    for (const tab of this.background) {
      if (this.d.isRemote(tab)) continue
      // ADR-0042
      const tools = (trees.members.get(tab) ?? []).filter((p) => !p.agent)
      const lowered = new Set([...(this.yielded.get(tab) ?? [])].filter((pid) => alive.has(pid)))
      this.yielded.set(tab, lowered)
      for (const p of tools) {
        cpu += p.cpuPercent
        bytes += p.rssBytes
        if (lowered.has(p.pid)) continue
        lowered.add(p.pid)
        newlyLowered.push(p.pid)
      }
    }
    await Promise.all(newlyLowered.map((pid) => this.d.giveWay(pid, true)))
    this.room.backgroundWorkRunning(
      this.room.lastReading.backgroundWork ??
        (cpu >= BACKGROUND_WORK_COUNTS_FROM_CPU_PERCENT ||
          bytes >= BACKGROUND_WORK_COUNTS_FROM_BYTES)
    )
  }

  private async calmDown(): Promise<void> {
    this.memory = {}
    this.sharedVmBytes = 0
    await Promise.all([...this.yielded.keys()].map((tab) => this.liftTab(tab)))
    this.room.backgroundWorkRunning(false)
  }

  private async liftTab(tabId: string): Promise<void> {
    const pids = this.yielded.get(tabId)
    this.yielded.delete(tabId)
    await Promise.all([...(pids ?? [])].map((pid) => this.d.giveWay(pid, false)))
  }

  launchInBackground(
    q: Omit<QueuedLaunch, 'since'>,
    start: () => Promise<string | null>,
    judgedHere = true
  ): InTurn {
    this.background.add(q.tabId)
    const turn = judgedHere ? this.queue.launch(q, start) : startedAtOnce(q.tabId, start)
    void turn.started.then((id) => {
      if (!id) this.background.delete(q.tabId)
    })
    return turn
  }

  isBackground(tabId: string): boolean {
    return this.background.has(tabId)
  }

  async free(tabId: string): Promise<boolean> {
    if (this.queue.startNow(tabId)) {
      this.background.delete(tabId)
      return true
    }
    if (!this.background.has(tabId)) return false
    this.background.delete(tabId)
    try {
      if (this.d.isRemote(tabId)) await this.d.freeOnMachine(tabId)
      else fs.writeFileSync(path.join(this.d.regDir, `${tabId}${FREE_SUFFIX}`), '')
    } catch (err) {
      this.background.add(tabId)
      this.d.log(`[koloft] machine: could not free ${tabId}: ${String(err)}`)
      return false
    }
    await this.liftTab(tabId)
    delete this.held[tabId]
    this.push()
    return true
  }

  forget(tabId: string): void {
    this.background.delete(tabId)
    this.queue.drop(tabId)
    void this.liftTab(tabId)
    fs.rmSync(path.join(this.d.regDir, `${tabId}${FREE_SUFFIX}`), { force: true })
  }

  state(): MachineState {
    const r = this.room.lastReading
    const busy = this.room.busy
    return {
      busy,
      pressure: busy ? r.pressure : null,
      load1: busy ? Math.round(r.load1 * 10) / 10 : 0,
      cores: this.d.cores,
      queued: this.queue.list(),
      held: this.held,
      background: [...this.background],
      memory: this.memory,
      sharedVmBytes: this.sharedVmBytes
    }
  }

  private readHeld(): Record<string, HeldCommand> {
    const out: Record<string, HeldCommand> = {}
    if (!this.background.size) return out
    const now = this.d.now()
    for (const dir of [this.d.regDir, ...this.d.heldDirs()]) {
      let names: string[]
      try {
        names = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const tabId = HELD_FILE.exec(name)?.[1]
        if (!tabId || !this.background.has(tabId)) continue
        try {
          const held = parseHeld(fs.readFileSync(path.join(dir, name), 'utf8'), now)
          if (held && (!out[tabId] || held.since < out[tabId].since)) out[tabId] = held
        } catch {}
      }
    }
    return out
  }

  private push(): void {
    const state = this.state()
    const text = JSON.stringify(state)
    if (text === this.last) return
    this.last = text
    this.d.changed(state)
  }
}
