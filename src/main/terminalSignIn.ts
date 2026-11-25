import {
  BACKEND_OF_SIGN_IN_FOLDER,
  keepsSecretInKeychain,
  type AccountKind,
  type AccountMeta,
  type AccountView,
  type SignInCommand,
  type SignInFolderKind,
  type SignInProgress,
  type SignInStart
} from '@shared/types'
import { shq } from '@shared/shellQuote'
import { MARK_OUTPUT_START, SignInOutput } from './signInOutput'
import { findAccount, keychainDelete, validateNewAccount } from './accounts'
import { installThen } from './toolInstall'

interface OwnTerminalSignIn {
  homeLogin(name: string): Promise<SignInCommand>
  probeHomeAccount(name: string): Promise<void>
}

interface HomeSignInTab {
  kind: SignInFolderKind
  name: string
  again: boolean
  output: SignInOutput
  probeHomeAccount(name: string): Promise<void>
}

export interface TerminalSignInDeps {
  usageViews: Map<string, Omit<AccountView, keyof AccountMeta>>
  viewKey(name: string, kind: AccountKind): string
  forgetAccount(name: string, kind: AccountKind): void
  noteHomeAccount(name: string, kind: SignInFolderKind): void
  homeShellTab(launchCommand: string): { tabId: string; cwd: string }
  toolInstallPtys: { add(id: string): unknown }
  signInChanged(progress: SignInProgress): void
  heldSignInFailure(): SignInProgress | null
  forgetHeldSignInFailure(): void
}

export function terminalSignInsOf(deps: TerminalSignInDeps) {
  const {
    usageViews,
    viewKey,
    forgetAccount,
    noteHomeAccount,
    homeShellTab,
    toolInstallPtys,
    signInChanged,
    heldSignInFailure,
    forgetHeldSignInFailure
  } = deps

  const signInPtys = new Map<string, HomeSignInTab>()

  async function endHomeSignIn(s: HomeSignInTab): Promise<void> {
    const probeAnswered = await s.probeHomeAccount(s.name).then(
      () => !usageViews.get(viewKey(s.name, s.kind))?.probeError,
      () => false
    )
    const account = findAccount(s.name, s.kind)
    if (!probeAnswered || !account || account.status === 'ok') return
    if (!s.again) forgetAccount(s.name, s.kind)
    signInChanged({
      kind: s.kind,
      name: s.name,
      again: s.again,
      phase: 'failed',
      tail: s.output.tail()
    })
  }

  async function signInToHome(
    kind: SignInFolderKind,
    name: string,
    again: boolean,
    own: OwnTerminalSignIn
  ): Promise<SignInStart> {
    const v = again
      ? findAccount(name, kind)
        ? 'ok'
        : 'invalid-name'
      : validateNewAccount(name, kind)
    if (v !== 'ok') return { ok: false, error: v }
    if (!again && keepsSecretInKeychain(kind) && !(await keychainDelete(kind, name)))
      return { ok: false, error: 'keychain' }
    if (heldSignInFailure()) forgetHeldSignInFailure()
    const login = await own.homeLogin(name)
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
    signInPtys.set(tab.tabId, {
      kind,
      name,
      again,
      output: new SignInOutput(),
      probeHomeAccount: own.probeHomeAccount
    })
    if (!login.binary) toolInstallPtys.add(tab.tabId)
    const progress: SignInProgress = { kind, name, again, phase: 'inATab', tab }
    signInChanged(progress)
    return { ok: true, progress }
  }

  return { signInPtys, endHomeSignIn, signInToHome }
}
