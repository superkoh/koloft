import type { SessionDefaults } from '@shared/types'
import { NO_DEFAULTS } from '@shared/sessionDefaults'

export const SET_ONCE_CONNECTED =
  'Koloft cannot reach this machine now, so it cannot tell which repository this is. Set these once it is connected.'

export const A_FOLDER_WITH_NO_REPOSITORY_IS_ASKED_AGAIN_AFTER_MS = 5 * 60_000

export interface ProjectDefaultsDeps {
  rootOf(dir: string): string
  reachable(root: string): Promise<unknown>
  repoOf(root: string, fresh: boolean): Promise<string | null>
  saved(): Record<string, SessionDefaults>
  save(all: Record<string, SessionDefaults>): void
  now(): number
}

export interface ProjectDefaults {
  of(dir: string): Promise<SessionDefaults | undefined>
  read(dir: string): Promise<SessionDefaults>
  write(
    dir: string,
    next: (saved: SessionDefaults | undefined) => SessionDefaults | undefined
  ): Promise<void>
}

export function projectDefaults(d: ProjectDefaultsDeps): ProjectDefaults {
  const askedFresh = new Map<string, { at: number; repo: string | null }>()
  const lastFound = new Map<string, string>()
  const freshRepoOf = async (root: string): Promise<string | null> => {
    const repo = await d.repoOf(root, true).catch(() => null)
    askedFresh.set(root, { at: d.now(), repo })
    return repo
  }
  const repoOf = async (root: string): Promise<string | null> => {
    const kept = await d.repoOf(root, false).catch(() => null)
    if (kept) return kept
    const asked = askedFresh.get(root)
    return asked && d.now() - asked.at < A_FOLDER_WITH_NO_REPOSITORY_IS_ASKED_AGAIN_AFTER_MS
      ? asked.repo
      : freshRepoOf(root)
  }
  const checkedKeyOf = async (dir: string): Promise<string> => {
    const root = d.rootOf(dir)
    await d.reachable(root).catch(() => {
      throw new Error(SET_ONCE_CONNECTED)
    })
    return (await freshRepoOf(root)) ?? root
  }
  return {
    of: async (dir) => {
      const saved = d.saved()
      if (Object.keys(saved).length === 0) return undefined
      try {
        const root = d.rootOf(dir)
        const found = await repoOf(root)
        if (found) lastFound.set(root, found)
        const unreachable =
          !found &&
          (await d.reachable(root).then(
            () => false,
            () => true
          ))
        return saved[found ?? (unreachable ? lastFound.get(root) : undefined) ?? root]
      } catch {
        return undefined
      }
    },
    read: async (dir) => d.saved()[await checkedKeyOf(dir)] ?? NO_DEFAULTS,
    write: async (dir, next) => {
      const key = await checkedKeyOf(dir)
      const all = { ...d.saved() }
      const kept = next(all[key])
      if (kept) all[key] = kept
      else delete all[key]
      d.save(all)
    }
  }
}
