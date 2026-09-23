import { useCallback, useEffect, useState } from 'react'
import type { HintId } from '@shared/types'
import { firedHints, selectorOf, type ActiveHint, type HintFire, type HintSnapshot } from './hints'
import { panelIsOpen, panelTabId, useStore } from './store'
import { updateSettings } from './components/settings/useSettingsUpdate'

const HINT_GAP_AFTER_DISMISS_MS = 2000

type State = ReturnType<typeof useStore.getState>

function panelShownOf(s: State): boolean {
  return panelIsOpen(s, panelTabId(s))
}

function mainHasAnsweredPanelState(s: State): boolean {
  const tab = panelTabId(s)
  return !tab || s.workbenchFetched[tab] === true
}

function snapOf(s: State): HintSnapshot {
  return {
    activeTabId: s.activeTabId,
    githubBtn: s.githubBtn,
    agentOpen: s.agentOpen,
    sessions: s.sessions,
    rows: s.workspaceRows
  }
}

export function useHints(): ActiveHint | null {
  const [queue, setQueue] = useState<HintFire[]>([])
  const [active, setActive] = useState<{ id: HintId; selector: string; n: number } | null>(null)
  const [readyAt, setReadyAt] = useState(0)
  const panelShown = useStore(panelShownOf)

  const enqueue = useCallback((f: HintFire): void => {
    const st = useStore.getState().settings
    if (st.hintsOff || st.hintsSeen.includes(f.id)) return
    setQueue((q) => (q.some((x) => x.id === f.id) ? q : [...q, f]))
  }, [])

  useEffect(() => {
    return useStore.subscribe((s, prev) => {
      for (const f of firedHints(snapOf(prev), snapOf(s))) enqueue(f)
    })
  }, [enqueue])

  useEffect(() => {
    if (active || queue.length === 0) return undefined
    const next = queue[0]
    let done = false
    const drop = (): void => {
      done = true
      setQueue((q) => q.filter((x) => x.id !== next.id))
    }
    const tryShow = (): void => {
      if (done || Date.now() < readyAt) return
      const st = useStore.getState()
      if (st.settingsOpen || st.update.open) return
      if (next.id === 'workbench') {
        if (!mainHasAnsweredPanelState(st)) return
        if (panelShownOf(st)) return drop()
      }
      if (!document.querySelector(selectorOf(next, panelShownOf(st)))) return
      const seen = st.settings.hintsSeen
      drop()
      updateSettings({ hintsSeen: [...seen, next.id] })
      setActive({ ...next, n: seen.length + 1 })
    }
    const t = setTimeout(tryShow, Math.max(0, readyAt - Date.now()))
    const off = useStore.subscribe(tryShow)
    return () => {
      clearTimeout(t)
      off()
    }
  }, [active, queue, readyAt])

  const onDone = useCallback((): void => {
    setReadyAt(Date.now() + HINT_GAP_AFTER_DISMISS_MS)
    setActive(null)
  }, [])

  const onOff = useCallback((): void => {
    updateSettings({ hintsOff: true })
    setQueue([])
    setActive(null)
  }, [])

  if (!active) return null
  return { ...active, selector: selectorOf(active, panelShown), onDone, onOff }
}
