import {
  BACKEND_OF_SIGN_IN_FOLDER,
  keepsSecretInKeychain,
  type AccountKind,
  type AccountMeta,
  type AccountView,
  type SignInFailure,
  type SignInFolderKind,
  type SignInResult
} from '@shared/types'
import { shq } from '@shared/shellQuote'
import { MARK_OUTPUT_START, SignInOutput } from './signInOutput'
import { findAccount, keychainDelete, validateNewAccount } from './accounts'
import { installThen } from './toolInstall'

interface HomeSignInTab {
  kind: SignInFolderKind
  name: string
  again: boolean
  output: SignInOutput
}

export interface TerminalSignInDeps {
  usageViews: Map<string, Omit<AccountView, keyof AccountMeta>>
  viewKey(name: string, kind: AccountKind): string
  forgetAccount(name: string, kind: AccountKind): void
  noteHomeAccount(name: string, kind: SignInFolderKind): void
  homeShellTab(launchCommand: string): { tabId: string; cwd: string }
  toolInstallPtys: { add(id: string): unknown }
  homeLogin: Record<
    SignInFolderKind,
    (name: string) => Promise<{ binary?: string; env: Record<string, string>; args?: string[] }>
  >
  probeHomeAccount: Record<SignInFolderKind, (name: string) => Promise<void>>
  signInFailure(): SignInFailure | null
  setSignInFailure(f: SignInFailure | null): void
}

export function terminalSignInsOf(deps: TerminalSignInDeps) {
  const {
    usageViews,
    viewKey,
    forgetAccount,
    noteHomeAccount,
    homeShellTab,
    toolInstallPtys,
    homeLogin,
    probeHomeAccount,
    signInFailure,
    setSignInFailure
  } = deps

  const signInPtys = new Map<string, HomeSignInTab>()

  async function endHomeSignIn(s: HomeSignInTab): Promise<void> {
    const probeAnswered = await probeHomeAccount[s.kind](s.name).then(
      () => !usageViews.get(viewKey(s.name, s.kind))?.probeError,
      () => false
    )
    const account = findAccount(s.name, s.kind)
    if (!probeAnswered || !account || account.status === 'ok') return
    if (!s.again) forgetAccount(s.name, s.kind)
    setSignInFailure({
      backend: BACKEND_OF_SIGN_IN_FOLDER[s.kind],
      name: s.name,
      again: s.again,
      tail: s.output.tail()
    })
  }

  async function signInToHome(
    kind: SignInFolderKind,
    name: string,
    again: boolean
  ): Promise<SignInResult> {
    const v = again
      ? findAccount(name, kind)
        ? 'ok'
        : 'invalid-name'
      : validateNewAccount(name, kind)
    if (v !== 'ok') return { ok: false, error: v }
    if (!again && keepsSecretInKeychain(kind) && !(await keychainDelete(kind, name)))
      return { ok: false, error: 'keychain' }
    if (signInFailure()) setSignInFailure(null)
    const login = await homeLogin[kind](name)
    noteHomeAccount(name, kind)
    const assignments = Object.entries(login.env).map(([k, val]) => `${k}=${shq(val)}`)
    const args = (login.args ?? ['login']).map(shq).join(' ')
    // PLATFORM§63
    const signIn = (quotedBinary: string): string =>
      `exec env ${assignments.join(' ')} ${quotedBinary} ${args}`
    const tab = homeShellTab(
      `${MARK_OUTPUT_START}; ` +
        (login.binary
          ? signIn(shq(login.binary))
          : installThen(
              BACKEND_OF_SIGN_IN_FOLDER[kind],
              signIn,
              process.env.KOLOFT_TEST_TOOL_INSTALLER
            ))
    )
    signInPtys.set(tab.tabId, { kind, name, again, output: new SignInOutput() })
    if (!login.binary) toolInstallPtys.add(tab.tabId)
    return { ok: true, ...tab }
  }

  return { signInPtys, endHomeSignIn, signInToHome }
}
