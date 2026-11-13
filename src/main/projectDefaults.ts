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
  const repoOf = (root: string, fresh: boolean): Promise<string | null> =>
    d.repoOf(root, fresh).catch(() => null)
  const checkedKeyOf = async (dir: string): Promise<string> => {
    const root = d.rootOf(dir)
    await d.reachable(root).catch(() => {
      throw new Error(SET_ONCE_CONNECTED)
    })
    return (await repoOf(root, true)) ?? root
  }
  return {
    of: async (dir) => {
      const saved = d.saved()
      if (Object.keys(saved).length === 0) return undefined
      const root = d.rootOf(dir)
      const repo = await repoOf(root, false)
      if (repo) return saved[repo]
      if (saved[root]) return saved[root]
      const fresh = await repoOf(root, true)
      return fresh ? saved[fresh] : undefined
    },
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
