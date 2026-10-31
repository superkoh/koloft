import fs from 'fs'
import { basename } from '@shared/preview'
import { barePath, formatRemoteKey, isAbsoluteOnHost } from '@shared/remoteKey'
import type { PreviewItem } from '@shared/types'

export type RealFilesLookup = (files: string[]) => Promise<Map<string, string>>
export type RealFilesOnMachine = (host: string, files: string[]) => Promise<Map<string, string>>

export const MACHINE_ASKS_AT_MOST_EVERY_MS = 2000

export async function localFile(p: string): Promise<string | null> {
  try {
    const real = await fs.promises.realpath(p)
    return (await fs.promises.stat(real)).isFile() ? real : null
  } catch {
    return null
  }
}

export async function realFilesHere(files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(
    files.map(async (file) => {
      const real = await localFile(file)
      if (real) out.set(file, real)
    })
  )
  return out
}

export function realFilesThere(host: string, onMachine: RealFilesOnMachine): RealFilesLookup {
  return async (files) => {
    const found = await onMachine(host, files.map(barePath))
    const out = new Map<string, string>()
    for (const file of files) {
      const real = found.get(barePath(file))
      if (real) out.set(file, formatRemoteKey(host, real))
    }
    return out
  }
}

export class RealFiles {
  private known = new Map<string, string>()
  private asking = new Set<string>()
  private wanted: string[] = []
  private lastAskMs = 0

  constructor(
    private lookup: RealFilesLookup,
    private found: () => void,
    private askGapMs = 0
  ) {}

  of(file: string): string | null {
    const real = this.known.get(file)
    if (real !== undefined) return real
    if (!this.asking.has(file)) {
      this.asking.add(file)
      if (this.wanted.push(file) === 1) this.askSoon()
    }
    return null
  }

  merge(items: PreviewItem[]): PreviewItem[] {
    const byReal = new Map<string, PreviewItem>()
    for (const item of items) {
      const real = this.of(item.src)
      if (!real) continue
      const ex = byReal.get(real)
      if (!ex) {
        byReal.set(real, { ...item, src: real, label: basename(real) })
        continue
      }
      ex.added = (ex.added ?? 0) + (item.added ?? 0) || undefined
      ex.removed = (ex.removed ?? 0) + (item.removed ?? 0) || undefined
      if (item.access === 'wrote') {
        ex.access = 'wrote'
        ex.wroteAt = Math.max(ex.wroteAt ?? 0, item.wroteAt ?? 0)
      }
    }
    return [...byReal.values()]
  }

  private askSoon(): void {
    const wait = this.lastAskMs + this.askGapMs - Date.now()
    if (wait > 0) setTimeout(() => void this.ask(), wait)
    else queueMicrotask(() => void this.ask())
  }

  private async ask(): Promise<void> {
    const files = this.wanted
    this.wanted = []
    this.lastAskMs = Date.now()
    let found: Map<string, string>
    try {
      found = await this.lookup(files)
    } catch {
      found = new Map(files.filter(isAbsoluteOnHost).map((f) => [f, f]))
    }
    for (const file of files) this.asking.delete(file)
    for (const [file, real] of found) this.known.set(file, real)
    if (found.size) this.found()
  }
}
