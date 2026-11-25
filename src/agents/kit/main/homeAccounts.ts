import type {
  AccountKind,
  AccountMeta,
  AccountView,
  BackendId,
  SignInFolderKind
} from '@shared/types'
import type { SavedHomeUsageOf } from '../../../main/savedHomeUsage'

export interface HomeAccountsDeps {
  app: { getPath(name: 'userData'): string }
  accountViews(): AccountView[]
  allLimitedNotice(a: AccountView, backend: BackendId): string | undefined
  findAccount(name: string, kind: AccountKind): AccountMeta | undefined
  foldHomeSignIn(name: string, kind: SignInFolderKind, signedIn: boolean): void
  listAccounts(): AccountMeta[]
  pushHomeAccount(name: string, kind: SignInFolderKind): void
  savedHomeUsageOf: SavedHomeUsageOf
  usageViews: Map<string, Omit<AccountView, keyof AccountMeta>>
  viewKey(name: string, kind: AccountKind): string
  sessionAccounts():
    { of(backend: BackendId, sessionId: string | undefined): string | undefined } | undefined
}
