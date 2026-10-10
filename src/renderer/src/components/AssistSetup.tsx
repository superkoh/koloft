import { useState, type JSX } from 'react'
import type { BackendId } from '@shared/types'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { useStore } from '../store'
import type { AssistSetupState } from '../useAssistSetup'
import { AddAccountDialog, CodexSignInDialog, LoginDialog } from './settings/AccountsPane'
import { useSettingsUpdate } from './settings/useSettingsUpdate'

// CC§9 CODEX§15
export const ASSIST_RUNS_ON: Record<BackendId, string> = {
  claude: 'Haiku, about 750 tokens a job',
  codex: 'GPT-6 Luna, a few thousand tokens a job'
}

export const ASSIST_COST_LINE =
  'Each Assist job costs a tiny bit of that account’s plan or API balance — far less than one cent.'

export function InstallHint({ children }: { children: string }): JSX.Element {
  return (
    <div className="quiet ob-warn">
      {children}
      <code className="ob-cmd">npm install -g @anthropic-ai/claude-code</code>
      <code className="ob-cmd">npm install -g @openai/codex</code>
    </div>
  )
}

// ADR-0030
export function AssistSetup({ setup }: { setup: AssistSetupState }): JSX.Element {
  const assist = useStore((s) => s.settings.assist)
  const login = useStore((s) => s.accountLogin)
  const beginLogin = useStore((s) => s.beginLogin)
  const setBypassAccepted = useStore((s) => s.setBypassAccepted)
  const update = useSettingsUpdate()
  const [codexSignIn, setCodexSignIn] = useState(false)
  const [pasting, setPasting] = useState(false)

  const pick = (b: BackendId): void => {
    if (setup.usable[b]) update({ assist: { on: true, backend: b } })
    else if (b === 'claude') beginLogin()
    else setCodexSignIn(true)
  }
  const acceptBypass = async (): Promise<void> => {
    if (await window.api.accounts.acceptBypass()) setBypassAccepted(true)
    else update({ skipPermissions: false })
  }

  if (setup.noTool)
    return (
      <div className="assist-setup">
        <InstallHint>Install Claude Code or Codex first, then come back to sign in.</InstallHint>
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
        {setup.tools.map((b) => (
          <button
            key={b}
            className={'choice' + (assist?.backend === b && setup.usable[b] ? ' on' : '')}
            onClick={() => pick(b)}
          >
            <span className="choice-t">{BACKEND_LABEL[b]}</span>
            <span className="choice-d">
              {setup.usable[b]
                ? `Signed in. Assist uses ${ASSIST_RUNS_ON[b]}.`
                : 'No account yet. Click to sign in.'}
            </span>
          </button>
        ))}
      </div>
      <div className="quiet">
        {ASSIST_COST_LINE} Turn it off any time in Settings ▸ Sessions; Koloft then does those jobs
        without AI. Have a Claude token?{' '}
        <button className="ob-link" onClick={() => setPasting(true)}>
          Paste it
        </button>
        .
      </div>
      {setup.askBypass && (
        <>
          <div className="quiet">
            Koloft starts Claude sessions without asking you before each file change or command. Is
            that OK?
          </div>
          <div className="ob-choices">
            <button className="choice" onClick={() => void acceptBypass()}>
              <span className="choice-t">Yes, don’t ask</span>
              <span className="choice-d">
                Koloft tells Claude you agreed, so a session started in the background never stops
                at its warning.
              </span>
            </button>
            <button className="choice" onClick={() => update({ skipPermissions: false })}>
              <span className="choice-t">No, ask me first</span>
              <span className="choice-d">Change it later in Settings ▸ Accounts.</span>
            </button>
          </div>
        </>
      )}
      {login && <LoginDialog />}
      {codexSignIn && <CodexSignInDialog onClose={() => setCodexSignIn(false)} />}
      {pasting && <AddAccountDialog kind="oauth" onClose={() => setPasting(false)} />}
    </div>
  )
}
