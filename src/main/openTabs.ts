import fs from 'fs'
import type { BackendId } from '@shared/types'
import { BackgroundFile } from './backgroundFile'

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
  awake: OpenTab[],
  asleep: OpenTab[],
  activeSessionId: string | undefined
): OpenTabs {
  const tabs = new Map<string, OpenTab>()
  for (const t of [...awake, ...asleep.map((s) => ({ ...s, asleep: true as const }))])
    if (!tabs.has(t.sessionId)) tabs.set(t.sessionId, t)
  return activeSessionId && tabs.has(activeSessionId)
    ? { tabs: [...tabs.values()], active: activeSessionId }
    : { tabs: [...tabs.values()] }
}

export interface RestorePlan {
  awake: OpenTab[]
  keepRunningOnly: string[]
  asleep: OpenTab[]
}

export function restorePlan(saved: OpenTabs, keepRunning: readonly string[]): RestorePlan {
  const resident = new Set(keepRunning)
  const awake = saved.tabs
    .filter((t) => !t.asleep || resident.has(t.sessionId))
    .map(({ asleep: _, ...t }) => t)
    .sort((a, b) => Number(b.sessionId === saved.active) - Number(a.sessionId === saved.active))
  const saw = new Set(saved.tabs.map((t) => t.sessionId))
  return {
    awake,
    keepRunningOnly: keepRunning.filter((id) => !saw.has(id)),
    asleep: saved.tabs.filter((t) => t.asleep && !resident.has(t.sessionId))
  }
}

export class OpenTabsFile {
  private written: string
  private readonly disk: BackgroundFile

  constructor(file: string, onDisk: OpenTabs) {
    this.disk = new BackgroundFile(() => file)
    this.written = JSON.stringify(onDisk)
  }

  write(state: OpenTabs): void {
    const text = JSON.stringify(state)
    if (text === this.written) return
    this.written = text
    this.disk.write(text)
  }

  flushSync(): void {
    this.disk.flushSync()
  }
}
