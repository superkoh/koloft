import type { SessionDefaults } from '@shared/types'
import { NO_DEFAULTS, sanitizeDefaults } from '@shared/sessionDefaults'

export const SET_ONCE_CONNECTED =
  'Koloft cannot reach this machine now, so it cannot tell which repository this is. Set these once it is connected.'

export interface ProjectDefaultsDeps {
  rootOf(dir: string): string
  reachable(root: string): Promise<unknown>
  repoOf(root: string, fresh: boolean): Promise<string | null>
  saved(): Record<string, SessionDefaults>
  save(all: Record<string, SessionDefaults>): void
}

export interface ProjectDefaults {
  of(dir: string): Promise<SessionDefaults | undefined>
  read(dir: string): Promise<SessionDefaults>
  write(dir: string, raw: unknown): Promise<void>
}

export function projectDefaults(d: ProjectDefaultsDeps): ProjectDefaults {
  const keyOf = async (dir: string, fresh: boolean): Promise<string> => {
    const root = d.rootOf(dir)
    return (await d.repoOf(root, fresh).catch(() => null)) ?? root
  }
  const checkedKeyOf = async (dir: string): Promise<string> => {
    await d.reachable(d.rootOf(dir)).catch(() => {
      throw new Error(SET_ONCE_CONNECTED)
    })
    return keyOf(dir, true)
  }
  return {
    of: async (dir) => d.saved()[await keyOf(dir, false)],
    read: async (dir) => d.saved()[await checkedKeyOf(dir)] ?? NO_DEFAULTS,
    write: async (dir, raw) => {
      const key = await checkedKeyOf(dir)
      const all = { ...d.saved() }
      const kept = sanitizeDefaults(raw)
      if (kept) all[key] = kept
      else delete all[key]
      d.save(all)
    }
  }
}
