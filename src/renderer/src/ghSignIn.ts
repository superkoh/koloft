import { useCallback, useEffect, useState } from 'react'
import type { GhAuthState } from '@shared/types'
import { useStore } from './store'

export function useGhSignIn(machine?: string): () => Promise<void> {
  const addTab = useStore((s) => s.addTab)
  const showSignInTab = useStore((s) => s.showSignInTab)
  return useCallback(async () => {
    const r = await window.api.github.signIn(machine)
    showSignInTab(r.tabId)
    addTab({
      id: r.tabId,
      kind: 'shell',
      title: machine ? `Sign in to GitHub on ${machine}` : 'Sign in to GitHub',
      cwd: r.cwd,
      alive: true
    })
  }, [addTab, showSignInTab, machine])
}

export function useGhAuthState(machine?: string): GhAuthState | null {
  const [state, setState] = useState<GhAuthState | null>(null)
  useEffect(() => {
    let alive = true
    const read = (): void =>
      void window.api.github.authState(machine).then((s) => {
        if (alive) setState(s)
      })
    read()
    const off = window.api.github.onAuthChanged(read)
    return () => {
      alive = false
      off()
    }
  }, [machine])
  return state
}
