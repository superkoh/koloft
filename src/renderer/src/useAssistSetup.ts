import { useEffect } from 'react'
import { hasUsableAccount } from '@shared/accountUsage'
import {
  ASSIST_BACKENDS,
  SESSION_BACKENDS,
  shownAsInstalled,
  type AssistBackend
} from '@shared/sessionBackend'
import { useStore } from './store'
import { useInstalledBackends } from './useInstalledBackends'

export interface AssistSetupState {
  tools: AssistBackend[]
  toolsKnown: boolean
  noTool: boolean
  usable: Record<AssistBackend, boolean>
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
  const { installed } = useInstalledBackends()

  useEffect(() => {
    if (bypassAccepted === null) void window.api.accounts.bypassAccepted().then(setBypassAccepted)
  }, [bypassAccepted, setBypassAccepted])

  const tools = ASSIST_BACKENDS.filter((b) => shownAsInstalled(installed, b))
  const askBypass = skipPermissions && bypassAccepted === false
  return {
    tools,
    toolsKnown: installed !== null,
    noTool: !SESSION_BACKENDS.some((b) => shownAsInstalled(installed, b)),
    usable: { claude, codex },
    askBypass,
    loaded: accountsLoaded && bypassAccepted !== null,
    done: (claude || codex) && assist !== null && !askBypass
  }
}
