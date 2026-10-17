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
      window.api.fs
        .gitChanges(dir, baseChoice)
        .then((r) => {
          if (mine !== seq) return
          setBase(r.base)
          setGit((prev) => (sameMap(prev, r.status, (x, y) => x === y) ? prev : r.status))
          setNumstat((prev) =>
            sameMap(prev, r.numstat, (x, y) => x.added === y.added && x.removed === y.removed)
              ? prev
              : r.numstat
          )
          setRootMissing(r.missing)
        })
        .catch(() => {})
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
