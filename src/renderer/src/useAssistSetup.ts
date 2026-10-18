import { useEffect } from 'react'
import { hasUsableAccount } from '@shared/accountUsage'
import { SESSION_BACKENDS, shownAsInstalled } from '@shared/sessionBackend'
import type { BackendId } from '@shared/types'
import { useStore } from './store'
import { useInstalledBackends } from './useInstalledBackends'

export interface AssistSetupState {
  tools: BackendId[]
  toolsKnown: boolean
  noTool: boolean
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
  const accountsLoaded = useStore((s) => s.accounts !== null)
  const claude = useStore((s) => hasUsableAccount(s.accounts ?? [], 'claude'))
  const codex = useStore((s) => hasUsableAccount(s.accounts ?? [], 'codex'))
  const muse = useStore((s) => hasUsableAccount(s.accounts ?? [], 'muse'))
  const agy = useStore((s) => hasUsableAccount(s.accounts ?? [], 'agy'))
  const { installed } = useInstalledBackends()

  useEffect(() => {
    if (bypassAccepted === null) void window.api.accounts.bypassAccepted().then(setBypassAccepted)
  }, [bypassAccepted, setBypassAccepted])

  const tools = SESSION_BACKENDS.filter((b) => shownAsInstalled(installed, b))
  const askBypass = skipPermissions && bypassAccepted === false
  return {
    tools,
    toolsKnown: installed !== null,
    noTool: tools.length === 0,
    usable: { claude, codex, muse, agy },
    askBypass,
    loaded: accountsLoaded && bypassAccepted !== null,
    done: (claude || codex || muse || agy) && assist !== null && !askBypass
  }
}
