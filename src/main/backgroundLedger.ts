import type { ReportedTask } from '@shared/sessionEvent'
import type { ToolUseResult } from './transcriptRecord'

const PROMOTED = '\x00promoted'
const TOOL_LABEL_CAP = 64
const TOOL_LABEL_CHARS = 120
const NOTHING_FINISHED: ReadonlySet<string> = new Set()

// CC§8
const BG_SPAWN_STATUSES = new Set(['async_launched', 'teammate_spawned', 'remote_launched'])

// CC§8
const TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'failed',
  'killed',
  'stopped',
  'cancelled',
  'canceled'
])

// CC§8
export function isBackgroundSpawnAck(tur: ToolUseResult | undefined): tur is ToolUseResult {
  if (!tur || typeof tur !== 'object') return false
  if (typeof tur.status === 'string' && BG_SPAWN_STATUSES.has(tur.status)) return true
  if (tur.status === 'forked' && tur.background === true) return true
  if (typeof tur.backgroundTaskId === 'string' && tur.backgroundTaskId) return true
  return typeof tur.taskId === 'string' && tur.taskId !== '' && typeof tur.timeoutMs === 'number'
}

export class BackgroundLedger {
  private live = new Set<string>()
  private taskLabels = new Map<string, string>()
  private monitors = new Set<string>()
  private toolLabels = new Map<string, string>()

  get held(): boolean {
    return this.live.size > 0
  }

  clear(): void {
    this.live.clear()
  }

  promote(): void {
    this.live.add(PROMOTED)
  }

  labelOf(taskId: string): string | undefined {
    return this.taskLabels.get(taskId)
  }

  isMonitor(taskId: string): boolean {
    return this.monitors.has(taskId)
  }

  noteToolLabel(toolUseId: string, label: string): void {
    if (this.toolLabels.size >= TOOL_LABEL_CAP)
      this.toolLabels.delete(this.toolLabels.keys().next().value as string)
    this.toolLabels.set(toolUseId, label.replace(/\s+/g, ' ').trim().slice(0, TOOL_LABEL_CHARS))
  }

  noteSpawnAck(tur: ToolUseResult, toolUseIds: string[]): ReportedTask | null {
    for (const id of toolUseIds) this.live.add(id)
    let task: ReportedTask | null = null
    if (typeof tur.backgroundTaskId === 'string') task = { id: tur.backgroundTaskId, type: 'shell' }
    else if (typeof tur.taskId === 'string' && typeof tur.timeoutMs === 'number') {
      task = { id: tur.taskId, type: 'shell' }
      this.monitors.add(tur.taskId)
    } else if (tur.status === 'teammate_spawned') {
      // CC§8
      if (toolUseIds[0]) task = { id: toolUseIds[0], type: 'teammate' }
    } else if (typeof tur.agentId === 'string') {
      task = {
        id: tur.agentId,
        type: tur.status === 'remote_launched' ? 'cloud-session' : 'subagent'
      }
    }
    if (task) {
      const cmd = toolUseIds.map((id) => this.toolLabels.get(id)).find((c) => c)
      if (cmd) this.taskLabels.set(task.id, cmd)
    }
    for (const id of toolUseIds) this.toolLabels.delete(id)
    return task
  }

  // CC§8
  noteNotification(text: string): ReadonlySet<string> {
    const blocks = [...text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)]
    const notices = blocks.length ? blocks.map(([notice]) => notice) : [text]
    const gone = new Set<string>()
    let finished = false
    for (const notice of notices) {
      const ids = [...notice.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((m) => m[1])
      const st = notice
        .match(/<status>([^<]*)<\/status>/)?.[1]
        ?.trim()
        .toLowerCase()
      if (st && TERMINAL_TASK_STATUSES.has(st)) {
        finished = true
        for (const m of notice.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g))
          this.live.delete(m[1])
        for (const id of ids) gone.add(id)
        continue
      }
      const monitorEvent = notice.match(/<summary>Monitor event: "?([^<]*?)"?<\/summary>/)
      if (!monitorEvent) continue
      for (const id of ids) {
        this.monitors.add(id)
        if (!this.taskLabels.has(id)) this.taskLabels.set(id, monitorEvent[1])
      }
    }
    if (!finished) return NOTHING_FINISHED
    for (const id of gone) {
      this.monitors.delete(id)
      this.taskLabels.delete(id)
    }
    this.live.delete(PROMOTED)
    return gone
  }
}
