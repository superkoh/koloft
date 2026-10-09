import { useEffect, useState } from 'react'
import type { AccountView, BackendAvailability, BackendId } from '@shared/types'
import { hasUsableAccount } from '@shared/accountUsage'
import { useStore } from './store'

export interface AssistSetupState {
  installed: BackendAvailability[] | null
  usable: Record<BackendId, boolean>
  askBypass: boolean
  loaded: boolean
  done: boolean
}

// ADR-0030
export function useAssistSetup(): AssistSetupState {
  const assist = useStore((s) => s.settings.assist)
  const skipPermissions = useStore((s) => s.settings.skipPermissions)
  const bypassAccepted = useStore((s) => s.bypassAccepted)
  const setBypassAccepted = useStore((s) => s.setBypassAccepted)
  const [accounts, setAccounts] = useState<AccountView[] | null>(null)
  const [installed, setInstalled] = useState<BackendAvailability[] | null>(null)

  useEffect(() => {
    let alive = true
    const apply = (next: AccountView[]): void => {
      if (alive) setAccounts(next)
    }
    const off = window.api.accounts.onUpdate(apply)
    void window.api.accounts.list().then(apply)
    void window.api.sessions.backends().then((b) => {
      if (alive) setInstalled(b)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    if (bypassAccepted === null) void window.api.accounts.bypassAccepted().then(setBypassAccepted)
  }, [bypassAccepted, setBypassAccepted])

  const usable = {
    claude: hasUsableAccount(accounts ?? [], 'claude'),
    codex: hasUsableAccount(accounts ?? [], 'codex')
  }
  const askBypass = skipPermissions && bypassAccepted === false
  return {
    installed,
    usable,
    askBypass,
    loaded: accounts !== null && bypassAccepted !== null,
    done: (usable.claude || usable.codex) && assist !== null && !askBypass
  }
}
