import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitNumstatMap, GitStatusMap } from '@shared/types'
import type { BaseChoice } from './filesModel'

export interface GitChangeSet {
  git: GitStatusMap
  numstat: GitNumstatMap
  base: string | null | undefined
  rootMissing: boolean
  watchDead: boolean
  reread: () => void
}

function sameMap<V>(
  a: Record<string, V>,
  b: Record<string, V>,
  eq: (x: V, y: V) => boolean
): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const k of keys) {
    if (!(k in b) || !eq(a[k], b[k])) return false
  }
  return true
}

export function useWatchlessRefresh(
  enabled: boolean,
  activityAt: number | undefined,
  throttleMs: number,
  refresh: () => void
): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!enabled || timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      refresh()
    }, throttleMs)
  }, [enabled, activityAt, throttleMs, refresh])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    },
    [enabled]
  )
}

export function useGitChangeSet(
  root: string | null,
  active: boolean,
  baseChoice: BaseChoice,
  refreshNonce: number
): GitChangeSet {
  const [git, setGit] = useState<GitStatusMap>({})
  const [numstat, setNumstat] = useState<GitNumstatMap>({})
  const [base, setBase] = useState<string | null | undefined>(undefined)
  const [rootMissing, setRootMissing] = useState(false)
  const [watchDead, setWatchDead] = useState(false)
  const fetchNow = useRef<(() => void) | null>(null)
  const reread = useCallback(() => fetchNow.current?.(), [])

  useEffect(() => {
    setGit({})
    setNumstat({})
    setBase(undefined)
    setRootMissing(false)
    setWatchDead(false)
  }, [root])

  useEffect(() => {
    if (active) return
    setGit({})
    setNumstat({})
    setBase(undefined)
  }, [active])

  useEffect(() => {
    if (!active || !root) return
    const dir = root
    let seq = 0
    const fetchGit = (): void => {
      const mine = ++seq
      const resolve: Promise<string | null> =
        baseChoice === 'head' ? Promise.resolve('HEAD') : window.api.fs.diffBase(dir)
      resolve
        .catch(() => null)
        .then((b) => {
          if (mine !== seq) return undefined
          setBase(b)
          const arg = b ?? undefined
          return Promise.all([
            window.api.fs.gitStatus(dir, arg),
            window.api.fs.gitNumstat(dir, arg),
            window.api.fs.dirExists(dir).then((ok) => !ok)
          ])
        })
        .then((r) => {
          if (!r || mine !== seq) return
          const [g, ns, missing] = r
          setGit((prev) => (sameMap(prev, g, (x, y) => x === y) ? prev : g))
          setNumstat((prev) =>
            sameMap(prev, ns, (x, y) => x.added === y.added && x.removed === y.removed) ? prev : ns
          )
          setRootMissing(missing)
        })
        .catch(() => {
          if (mine !== seq) return
        })
    }
    fetchGit()
    fetchNow.current = fetchGit
    let watching = true
    window.api.fs.watchDir(dir).then((live) => {
      if (watching) setWatchDead(!live)
    })
    const off = window.api.fs.onDirChange((changed) => {
      if (changed === dir) fetchGit()
    })
    return () => {
      seq++
      fetchNow.current = null
      watching = false
      off()
      window.api.fs.unwatchDir(dir)
    }
  }, [active, root, baseChoice, refreshNonce])

  return { git, numstat, base, rootMissing, watchDead, reread }
}
