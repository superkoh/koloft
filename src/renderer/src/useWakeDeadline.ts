import { useEffect, useRef } from 'react'
import { useStore } from './store'

// CC§9
const A_WAKING_TAB_SHOWS_ITS_REAL_SCREEN_AFTER_MS = 5000

export function useWakeDeadline(): void {
  const waking = useStore((s) =>
    s.tabs
      .filter((t) => t.ghost && !t.wakeOverdue)
      .map((t) => t.id)
      .join('\n')
  )
  const timers = useRef(new Map<string, number>())
  useEffect(() => {
    const ids = new Set(waking ? waking.split('\n') : [])
    for (const [id, timer] of timers.current) {
      if (ids.has(id)) continue
      clearTimeout(timer)
      timers.current.delete(id)
    }
    for (const id of ids) {
      if (timers.current.has(id)) continue
      const timer = window.setTimeout(() => {
        timers.current.delete(id)
        useStore.getState().markWakeOverdue(id)
      }, A_WAKING_TAB_SHOWS_ITS_REAL_SCREEN_AFTER_MS)
      timers.current.set(id, timer)
    }
  }, [waking])
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
    }
  }, [])
}
