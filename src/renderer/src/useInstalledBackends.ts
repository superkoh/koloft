import { useEffect, useState } from 'react'
import type { BackendAvailability } from '@shared/types'

let lastAnswerThisRun: BackendAvailability[] | null = null

export function useToolsChanged(): number {
  const [changes, setChanges] = useState(0)
  useEffect(() => window.api.sessions.onToolsChanged(() => setChanges((n) => n + 1)), [])
  return changes
}

export function useInstalledBackends(recheck = 0): {
  installed: BackendAvailability[] | null
  checkFailed: boolean
} {
  const [installed, setInstalled] = useState(lastAnswerThisRun)
  const [checkFailed, setCheckFailed] = useState(false)
  const toolsChanged = useToolsChanged()
  useEffect(() => {
    let alive = true
    setCheckFailed(false)
    void window.api.sessions.backends().then(
      (list) => {
        lastAnswerThisRun = list
        if (alive) setInstalled(list)
      },
      () => {
        if (alive) setCheckFailed(true)
      }
    )
    return () => {
      alive = false
    }
  }, [recheck, toolsChanged])
  return { installed, checkFailed }
}
