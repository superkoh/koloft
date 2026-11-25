import { useShallow } from 'zustand/react/shallow'
import { ofEachAgent } from '@core/agent/registry'
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
}

// ADR-0030
export function useAssistSetup(): AssistSetupState {
  const skipPermissions = useStore((s) => s.settings.skipPermissions)
  const agreed = useStore((s) => s.settings.skipPermissionsAgreed)
  const accountsLoaded = useStore((s) => s.accounts !== null)
  const usable = useStore(
    useShallow((s) => ofEachAgent((b) => hasUsableAccount(s.accounts ?? [], b)))
  )
  const { installed } = useInstalledBackends()

  const tools = SESSION_BACKENDS.filter((b) => shownAsInstalled(installed, b))
  const askBypass = skipPermissions && !agreed
  return {
    tools,
    toolsKnown: installed !== null,
    noTool: tools.length === 0,
    usable,
    askBypass,
    loaded: accountsLoaded
  }
}
