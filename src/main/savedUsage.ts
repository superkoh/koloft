import fs from 'fs'
import type { UsageSnapshot } from '@shared/types'
import { FIVE_HOUR_MINUTES } from '@shared/accountUsage'
import { BackgroundFile } from './backgroundFile'

export const SNAPSHOT_OLDER_THAN_THE_5H_WINDOW_MS = FIVE_HOUR_MINUTES * 60_000

function readSnapshots<T extends { at: number }>(file: string, nowMs: number): [string, T][] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    return Object.entries(raw).filter(
      (e): e is [string, T] =>
        !!e[1] &&
        typeof e[1] === 'object' &&
        nowMs - (e[1] as T).at < SNAPSHOT_OLDER_THAN_THE_5H_WINDOW_MS
    )
  } catch {
    return []
  }
}

export class SavedUsage<T extends { at: number } = UsageSnapshot> {
  private readonly byKey: Map<string, T>
  private readonly disk: BackgroundFile

  constructor(file: string, nowMs = Date.now()) {
    this.byKey = new Map(readSnapshots<T>(file, nowMs))
    this.disk = new BackgroundFile(() => file)
  }

  get(key: string): T | undefined {
    return this.byKey.get(key)
  }

  set(key: string, usage: T): void {
    this.byKey.set(key, usage)
    this.save()
  }

  delete(key: string): void {
    if (this.byKey.delete(key)) this.save()
  }

  flushSync(): void {
    this.disk.flushSync()
  }

  private save(): void {
    this.disk.write(JSON.stringify(Object.fromEntries(this.byKey)))
  }
}
