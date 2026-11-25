import { signInKindOf } from '@core/agent/registry'
import { agentUi } from '@agents/uis'
import type { AccountKind, BackendId } from '@shared/types'

export const signsInInATab = (agent: BackendId): boolean => agentUi(agent).accounts.signIn.inATab

export const signInKindIdOf = (agent: BackendId): AccountKind =>
  signInKindOf(agent).id as AccountKind
