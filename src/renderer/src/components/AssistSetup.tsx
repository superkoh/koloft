import { useState, type JSX } from 'react'
import type { BackendId } from '@shared/types'
import { accountToSignInAgain } from '@shared/accountUsage'
import { assistRunsOn } from '@shared/assistPicks'
import { settingsPaneName } from '@shared/paletteFeatures'
import { BACKEND_LABEL, SESSION_BACKENDS, productList } from '@shared/sessionBackend'
import { assistInputs } from '../butlerRows'
import { useStore } from '../store'
import type { AssistSetupState } from '../useAssistSetup'
import {
  AddAccountDialog,
  LoginDialog,
  SignInDialog,
  SignInFailedCard,
  loginRunning,
  useSignInFailure,
  type PaneForm
} from './settings/AccountsPane'
import { useSettingsUpdate } from './settings/useSettingsUpdate'

// CC§9 CODEX§15
export const ASSIST_COST_LINE =
  'Each Assist job costs a little of that account’s plan or API balance: about a cent or less.'

function InstallChoice({ backend }: { backend: BackendId }): JSX.Element {
  const openSignInTab = useStore((s) => s.openSignInTab)
  const install = async (): Promise<void> => {
    const r = await window.api.sessions.installTool(backend)
    if (r) openSignInTab(r, `Install ${BACKEND_LABEL[backend]}`)
  }
  return (
    <button className="choice" onClick={() => void install()}>
      <span className="choice-t">{BACKEND_LABEL[backend]}</span>
      <span className="choice-d">Not on this Mac. Click to install.</span>
    </button>
  )
}

export const NO_AGENT_ON_THIS_MAC = `Koloft runs ${productList(SESSION_BACKENDS, 'or')}, and this Mac has none of them yet. Pick one to install: a terminal opens and runs its official installer. Nothing else to set up first.`

export function InstallHint({ children }: { children: string }): JSX.Element {
  return (
    <>
      <div className="quiet">{children}</div>
      <div className="ob-choices">
        {SESSION_BACKENDS.map((b) => (
          <InstallChoice key={b} backend={b} />
        ))}
      </div>
    </>
  )
}

// ADR-0030
export function AssistSetup({
  setup,
  offerInstall = false
}: {
  setup: AssistSetupState
  offerInstall?: boolean
}): JSX.Element {
  const assist = useStore((s) => s.settings.assist)
  const runsOn = useStore((s) => assistRunsOn(assistInputs(s)))
  const accounts = useStore((s) => s.accounts) ?? []
  const login = useStore((s) => s.accountLogin)
  const beginLogin = useStore((s) => s.beginLogin)
  const clearLogin = useStore((s) => s.clearLogin)
  const failed = useSignInFailure()
  const update = useSettingsUpdate()
  const [form, setForm] = useState<PaneForm | null>(null)
  const claudeLoginRunning = !!login && loginRunning(login.progress)
  const closeForms = (): void => {
    if (login && !claudeLoginRunning) clearLogin()
    if (failed) window.api.accounts.dismissSignInFailure()
    setForm(null)
  }
  const openForm = (next: PaneForm): void => {
    closeForms()
    setForm(next)
  }
  const openClaudeSignIn = (again: string | undefined): void => {
    closeForms()
    if (!claudeLoginRunning) beginLogin(again)
  }
  const signIn = form && 'signIn' in form ? form : null

  const pick = (b: BackendId, again: string | undefined): void => {
    if (setup.usable[b]) {
      closeForms()
      update({ assist: { ...assist, backend: b } })
    } else if (b === 'claude') openClaudeSignIn(again)
    else openForm({ signIn: b, again })
  }

  if (setup.noTool)
    return (
      <div className="assist-setup">
        <InstallHint>{NO_AGENT_ON_THIS_MAC}</InstallHint>
      </div>
    )

  return (
    <div className="assist-setup">
      <div className="quiet">
        Every session in Koloft runs on an account you add here, never on the login this Mac already
        has. Add one, then pick the one that does Koloft’s small jobs, like naming a new session.
        That is <b>Koloft Assist</b>.
      </div>
      <div className="ob-choices">
        {SESSION_BACKENDS.map((b) => {
          if (!setup.tools.includes(b))
            return offerInstall && setup.toolsKnown ? <InstallChoice key={b} backend={b} /> : null
          const again = accountToSignInAgain(accounts, b)
          return (
            <button
              key={b}
              className={'choice' + (runsOn === b && setup.usable[b] ? ' on' : '')}
              onClick={() => pick(b, again)}
            >
              <span className="choice-t">{BACKEND_LABEL[b]}</span>
              <span className="choice-d">
                {setup.usable[b]
                  ? runsOn === b
                    ? 'Signed in. Assist runs on it.'
                    : 'Signed in.'
                  : again
                    ? `"${again}" is not signed in. Click to sign in again.`
                    : 'No account yet. Click to sign in.'}
              </span>
            </button>
          )
        })}
      </div>
      <div className="quiet">
        {ASSIST_COST_LINE} Choose what each job runs on in {settingsPaneName('assist')}. Have a
        Claude token?{' '}
        <button className="ob-link" onClick={() => openForm({ paste: 'oauth' })}>
          Paste it
        </button>
        .
      </div>
      {setup.askBypass && (
        <>
          <div className="quiet">
            Koloft starts sessions without asking you before each file change or command. Is that
            OK?
          </div>
          <div className="ob-choices">
            <button className="choice" onClick={() => update({ skipPermissionsAgreed: true })}>
              <span className="choice-t">Yes, don’t ask</span>
              <span className="choice-d">
                Koloft remembers your answer. Your own Claude settings stay as they are.
              </span>
            </button>
            <button className="choice" onClick={() => update({ skipPermissions: false })}>
              <span className="choice-t">No, ask me first</span>
              <span className="choice-d">Change it later in Settings ▸ Accounts.</span>
            </button>
          </div>
        </>
      )}
      {form && 'paste' in form ? (
        <AddAccountDialog kind={form.paste} onClose={() => setForm(null)} />
      ) : signIn ? (
        <SignInDialog
          key={`${signIn.signIn}:${signIn.again ?? ''}`}
          backend={signIn.signIn}
          again={signIn.again}
          onClose={() => setForm((open) => (open === signIn ? null : open))}
        />
      ) : login ? (
        <LoginDialog key={login.reauthName ?? ''} />
      ) : (
        failed && <SignInFailedCard failed={failed} />
      )}
    </div>
  )
}
