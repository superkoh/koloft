import type {
  AccountAddResult,
  AccountKind,
  AccountMeta,
  AccountView,
  BackendId,
  SignInCommand,
  SignInFolderKind,
  SignInStart
} from '@shared/types'
import type { SavedHomeUsageOf } from '../../../main/savedHomeUsage'

export interface HomeAccountsDeps {
  app: { getPath(name: 'userData'): string }
  accountViews(): AccountView[]
  allLimitedNotice(a: AccountView, backend: BackendId): string | undefined
  findAccount(name: string, kind: AccountKind): AccountMeta | undefined
  foldHomeSignIn(name: string, kind: SignInFolderKind, signedIn: boolean): void
  listAccounts(): AccountMeta[]
  noteHomeAccount(name: string, kind: SignInFolderKind): void
  pushHomeAccount(name: string, kind: SignInFolderKind): void
  savedHomeUsageOf: SavedHomeUsageOf
  usageViews: Map<string, Omit<AccountView, keyof AccountMeta>>
  viewKey(name: string, kind: AccountKind): string
  sessionAccounts():
    { of(backend: BackendId, sessionId: string | undefined): string | undefined } | undefined
  signInInATab(
    kind: SignInFolderKind,
    name: string,
    again: boolean,
    own: {
      homeLogin(name: string): Promise<SignInCommand>
      probeHomeAccount(name: string): Promise<void>
    }
  ): Promise<SignInStart>
}

interface UtilTerminalPick {
  account: string
  home: string
  banner?: string
  warning?: string
  kind?: 'apikey'
}

export function terminalPickOf(
  picked: { account: string; home: string; banner?: string; notice?: string } | undefined
): UtilTerminalPick | undefined {
  return (
    picked && {
      account: picked.account,
      home: picked.home,
      banner: picked.banner,
      warning: picked.notice
    }
  )
}

export async function answerOfTerminalPick(
  backend: BackendId,
  pick: () => UtilTerminalPick | undefined
): Promise<object> {
  let picked: UtilTerminalPick | undefined
  try {
    picked = pick()
  } catch (err) {
    console.error(`[koloft] picking a ${backend} account for a terminal failed:`, err)
  }
  return picked ?? {}
}

export async function addHomeKey(
  kind: SignInFolderKind,
  name: string,
  key: string,
  own: {
    storeHomeKey(name: string, key: string): Promise<void>
    probeHomeAccount(name: string): Promise<void>
  },
  deps: Pick<HomeAccountsDeps, 'noteHomeAccount' | 'accountViews'>
): Promise<AccountAddResult> {
  const { noteHomeAccount, accountViews } = deps
  try {
    await own.storeHomeKey(name, key)
  } catch {
    return { ok: false, error: 'unknown' }
  }
  noteHomeAccount(name, kind)
  await own.probeHomeAccount(name)
  const account = accountViews().find((a) => a.kind === kind && a.name === name)
  return { ok: account?.status === 'ok', account }
}
