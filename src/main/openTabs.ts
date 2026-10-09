import fs from 'fs'
import type { BackendId } from '@shared/types'
import { writePrivateAtomically } from './privateFile'

export interface OpenTab {
  sessionId: string
  kind: BackendId
  title: string
  cwd: string
  asleep?: true
}

export interface OpenTabs {
  tabs: OpenTab[]
  active?: string
}

export interface LiveTab {
  sessionId: string
  kind: BackendId
  title: string
  cwd: string
}

const NOTHING_OPEN: OpenTabs = { tabs: [] }

function isOpenTab(v: unknown): v is OpenTab {
  const t = v as OpenTab
  return (
    !!t &&
    typeof t.sessionId === 'string' &&
    !!t.sessionId &&
    (t.kind === 'claude' || t.kind === 'codex') &&
    typeof t.title === 'string' &&
    typeof t.cwd === 'string'
  )
}

export function readOpenTabs(file: string): OpenTabs {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as OpenTabs
    const tabs = Array.isArray(raw?.tabs) ? raw.tabs.filter(isOpenTab) : []
    return typeof raw.active === 'string' ? { tabs, active: raw.active } : { tabs }
  } catch {
    return NOTHING_OPEN
  }
}

export function openTabsNow(
  live: LiveTab[],
  asleep: OpenTab[],
  activeSessionId: string | undefined
): OpenTabs {
  const seen = new Set<string>()
  const tabs: OpenTab[] = []
  for (const t of live) {
    if (seen.has(t.sessionId)) continue
    seen.add(t.sessionId)
    tabs.push({ sessionId: t.sessionId, kind: t.kind, title: t.title, cwd: t.cwd })
  }
  for (const t of asleep) {
    if (seen.has(t.sessionId)) continue
    seen.add(t.sessionId)
    tabs.push({ ...t, asleep: true })
  }
  return activeSessionId && seen.has(activeSessionId) ? { tabs, active: activeSessionId } : { tabs }
}

export interface RestorePlan {
  awake: string[]
  asleep: OpenTab[]
}

export function restorePlan(saved: OpenTabs, keepRunning: readonly string[]): RestorePlan {
  const resident = new Set(keepRunning)
  const awake = saved.tabs.filter((t) => !t.asleep || resident.has(t.sessionId))
  const awakeIds = awake.map((t) => t.sessionId)
  for (const id of keepRunning) if (!awakeIds.includes(id)) awakeIds.push(id)
  const activeFirst = saved.active && awakeIds.includes(saved.active) ? saved.active : undefined
  return {
    awake: activeFirst ? [activeFirst, ...awakeIds.filter((id) => id !== activeFirst)] : awakeIds,
    asleep: saved.tabs.filter((t) => t.asleep && !resident.has(t.sessionId))
  }
}

export class OpenTabsFile {
  private written: string

  constructor(private file: string) {
    this.written = JSON.stringify(readOpenTabs(file))
  }

  write(state: OpenTabs): void {
    const text = JSON.stringify(state)
    if (text === this.written) return
    try {
      writePrivateAtomically(this.file, text)
      this.written = text
    } catch {}
  }
}
