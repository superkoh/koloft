import { useCallback, useEffect, useState } from 'react'
import type { HintId } from '@shared/types'
import { firedHints, selectorOf, type ActiveHint, type HintFire, type HintSnapshot } from './hints'
import { panelIsOpen, panelTabId, useStore } from './store'
import { updateSettings } from './components/settings/useSettingsUpdate'

/** How long the next queued hint holds back once one has been dismissed — two cards in
 *  a row read as an interruption, not as help. */
const HINT_GAP_MS = 2000

type State = ReturnType<typeof useStore.getState>

/** T3 (full width) is derived from T2's own flag, so this one flag is the whole answer. */
function panelShownOf(s: State): boolean {
  return panelIsOpen(s, panelTabId(s))
}

/**
 * Has main answered yet for the panel on screen?
 *
 * The collapsed/expanded flag lives in main, so for one IPC round trip after a session is
 * selected the renderer holds nothing — and `panelIsOpen` reads that silence as
 * "collapsed". A file written inside that window (fake-claude's startup turn, and a real
 * claude's first tool call) would spend the one-shot `workbench` card on a Workbench the
 * user can already see.
 */
function panelKnown(s: State): boolean {
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

/**
 * Layer B — the contextual hints, mounted ONCE in App.
 *
 * Every one of them is a store transition (`firedHints`). A hint the user has already seen, or one
 * `hintsOff` silenced, is never queued — so a trigger whose conditions are not met this
 * time stays armed for the next.
 */
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

  // One at a time: the head of the queue shows as soon as the gap since the last one has
  // passed. Showing IS seeing — the id is written the moment the card goes up, so a quit
  // with it still on screen does not bring it back.
  //
  // Three things stop a card going up, and each of them is a store fact — which is why
  // the retry is the store's own subscription and not a timer: a modal is on screen; the
  // `workbench` card would sit over a panel the user can already see (dropped, since the
  // write it is about is no longer news) or over one main has not answered for yet
  // (held); the anchor is not on screen at all (a folded workspace renders no rows).
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
        if (!panelKnown(st)) return
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
    setReadyAt(Date.now() + HINT_GAP_MS)
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
