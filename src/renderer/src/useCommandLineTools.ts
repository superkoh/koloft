import { useEffect, useState } from 'react'

export function useCommandLineToolsMissing(ask: boolean): boolean {
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (!ask) return
    let alive = true
    void window.api.sessions.commandLineToolsMissing().then((m) => {
      if (alive) setMissing(m)
    })
    return () => {
      alive = false
    }
  }, [ask])
  return ask && missing
}
