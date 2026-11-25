import { signInKindOf } from '@core/agent/registry'
import type { AccountKind, BackendId } from '@shared/types'

export const signsInInATab = (agent: BackendId): boolean => signInKindOf(agent).isASignInFolder

export const signInKindIdOf = (agent: BackendId): AccountKind =>
  signInKindOf(agent).id as AccountKind
