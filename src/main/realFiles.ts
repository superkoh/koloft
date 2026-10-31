import fs from 'fs'
import { basename } from '@shared/preview'
import { formatRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import type { PreviewItem } from '@shared/types'

export type RealFilesLookup = (files: string[]) => Promise<Map<string, string>>
export type RealFilesOnMachine = (host: string, files: string[]) => Promise<Map<string, string>>

export async function realFilesHere(files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(
    files.map(async (file) => {
      try {
        if ((await fs.promises.stat(file)).isFile()) out.set(file, await fs.promises.realpath(file))
      } catch {}
    })
  )
  return out
}

export function realFilesThere(host: string, onMachine: RealFilesOnMachine): RealFilesLookup {
  return async (files) => {
    const bare = files.map((f) => parseRemoteKey(f)?.path ?? f)
    const found = await onMachine(host, bare)
    const out = new Map<string, string>()
    files.forEach((file, i) => {
      const real = found.get(bare[i])
      if (real) out.set(file, parseRemoteKey(file) ? formatRemoteKey(host, real) : real)
    })
    return out
  }
}

export class RealFiles {
  private known = new Map<string, string>()
  private asking = new Set<string>()
  private wanted: string[] = []

  constructor(
    private lookup: RealFilesLookup,
    private found: () => void
  ) {}

  of(file: string): string | null {
    const real = this.known.get(file)
    if (real !== undefined) return real
    if (!this.asking.has(file)) {
      this.asking.add(file)
      if (this.wanted.push(file) === 1) queueMicrotask(() => void this.ask())
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

  private async ask(): Promise<void> {
    const files = this.wanted
    this.wanted = []
    let found = new Map<string, string>()
    try {
      found = await this.lookup(files)
    } catch {}
    for (const file of files) this.asking.delete(file)
    for (const [file, real] of found) this.known.set(file, real)
    if (found.size) this.found()
  }
}
