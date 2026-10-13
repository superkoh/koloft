import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { LuCopy, LuExternalLink, LuLoaderCircle, LuPlus, LuX } from 'react-icons/lu'
import type { GitAccountView, GitLoginProgress, GitTokenAddResult } from '@shared/types'
import { basename } from '@shared/preview'
import { useStore } from '../../store'
import { useEscConsumer } from './escScope'

const DEFAULT_TITLE = 'First choice when a workspace on this host picks an account'
const GITHUB_SCOPES = 'repo, read:org, gist, workflow'
const CREATE_TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo,read:org,gist,workflow&description=Koloft'

type AddMode =
  | { step: 'host' }
  | { step: 'login'; progress: GitLoginProgress; again?: string }
  | { step: 'token'; why?: string }

function workspacesLabel(n: number): string {
  return `${n} workspace${n === 1 ? '' : 's'}`
}

function rowNote(a: GitAccountView): string {
  const used = a.usedBy.length
    ? `used by ${workspacesLabel(a.usedBy.length)}`
    : 'Not used by any workspace yet'
  if (a.status === 'expired') return used
  const state = a.checkError === 'offline' ? 'Last seen signed in' : 'Signed in'
  return `${state} · ${used.charAt(0).toLowerCase()}${used.slice(1)}`
}

function tokenError(r: GitTokenAddResult): string | null {
  if (r.ok) return null
  if (r.error === 'rejected')
    return 'GitHub turned this token down. Check that you copied all of it and that it has not expired.'
  if (r.error === 'offline') return 'Could not reach GitHub. Check your network and try again.'
  if (r.error === 'missing-scope')
    return `This token lacks the ${r.scope ?? 'repo'} permission. Make a classic token with ${GITHUB_SCOPES} ticked.`
  return 'Could not check this token with GitHub.'
}

export function GitAccountsSection(): JSX.Element {
  const [accounts, setAccounts] = useState<GitAccountView[]>([])
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [adding, setAdding] = useState<AddMode | null>(null)
  const focus = useStore((s) => s.settingsFocus)
  const setFocus = useStore((s) => s.setSettingsFocus)
  const headRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!focus) return
    if (focus === 'git-token') setAdding({ step: 'token' })
    headRef.current?.scrollIntoView({ block: 'start' })
    setFocus(null)
  }, [focus, setFocus])

  useEffect(() => {
    let alive = true
    const apply = (next: GitAccountView[]): void => {
      if (alive) setAccounts(next)
    }
    const off = window.api.gitAccounts.onUpdate(apply)
    void window.api.gitAccounts.list().then(apply)
    void window.api.gitAccounts.check()
    return () => {
      alive = false
      off()
    }
  }, [])

  useEscConsumer(
    confirmDel !== null,
    useCallback(() => setConfirmDel(null), [])
  )
  useEffect(() => {
    if (confirmDel === null) return
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.acct-row.confirming')) setConfirmDel(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [confirmDel])

  const signingIn = adding?.step === 'login'
  useEffect(() => {
    if (!signingIn) return
    const off = window.api.gitAccounts.onLoginProgress((p) => {
      if (p.phase === 'saved') {
        setAdding(null)
        return
      }
      setAdding((cur) => (cur?.step === 'login' ? { ...cur, progress: p } : cur))
    })
    return () => {
      off()
      window.api.gitAccounts.loginCancel()
    }
  }, [signingIn])

  const startLogin = async (again?: string): Promise<void> => {
    setAdding({ step: 'login', progress: { phase: 'checking' }, again })
    const r = await window.api.gitAccounts.loginStart()
    if (r.ok) return
    if (r.error === 'busy') {
      setAdding({
        step: 'login',
        progress: { phase: 'failed', message: 'Another GitHub sign-in is already running.' },
        again
      })
      return
    }
    setAdding({
      step: 'token',
      why:
        r.error === 'no-gh'
          ? 'GitHub CLI is not available, so paste a token instead.'
          : 'This Mac cannot run the GitHub CLI sign-in safely, so paste a token instead.'
    })
  }

  return (
    <>
      <div className="set-grp" ref={headRef}>
        Git accounts
      </div>
      <div className="acct-section">
        {accounts.length === 0 ? (
          <div className="acct-empty">
            No git accounts yet. Koloft uses your own git setup until you add one.
          </div>
        ) : (
          <div className="acct-list">
            {accounts.map((a) => (
              <GitAccountRow
                key={a.login}
                account={a}
                confirming={confirmDel === a.login}
                onAskRemove={() => setConfirmDel(a.login)}
                onCancelRemove={() => setConfirmDel(null)}
                onRemove={() => {
                  setConfirmDel(null)
                  void window.api.gitAccounts.remove(a.login)
                }}
                onRelogin={() => void startLogin(a.login)}
                onMakeDefault={() => void window.api.gitAccounts.makeDefault(a.login)}
              />
            ))}
          </div>
        )}
        <div className="acct-foot">
          <button
            className="mini"
            title="Pick a host, then sign in or paste a token"
            onClick={() => setAdding({ step: 'host' })}
          >
            <LuPlus size={14} /> Add account
          </button>
        </div>
        <span className="field-hint">
          A workspace with no pick keeps using your own git setup. Adding an account or signing in
          again never changes other workspaces.
        </span>
      </div>
      {adding?.step === 'host' && (
        <div className="acct-add">
          <div className="acct-add-title">Add account</div>
          <div className="chips">
            <button className="chip on">GitHub</button>
          </div>
          <div className="acct-add-actions">
            <button className="mini" onClick={() => setAdding(null)}>
              Cancel
            </button>
            <button className="mini" onClick={() => void startLogin()}>
              Next
            </button>
          </div>
          <span className="field-hint">
            GitHub signs in through a sign-in window, or takes a token. The account is kept on this
            Mac only.
          </span>
        </div>
      )}
      {adding?.step === 'login' && (
        <GitLoginBox
          again={adding.again}
          progress={adding.progress}
          onRetry={() => void startLogin(adding.again)}
          onToken={() => setAdding({ step: 'token' })}
          onClose={() => setAdding(null)}
        />
      )}
      {adding?.step === 'token' && <GitTokenBox why={adding.why} onClose={() => setAdding(null)} />}
    </>
  )
}

function GitAccountRow({
  account: a,
  confirming,
  onAskRemove,
  onCancelRemove,
  onRemove,
  onRelogin,
  onMakeDefault
}: {
  account: GitAccountView
  confirming: boolean
  onAskRemove(): void
  onCancelRemove(): void
  onRemove(): void
  onRelogin(): void
  onMakeDefault(): void
}): JSX.Element {
  const used = a.usedBy.map((p) => basename(p))
  return (
    <div className={'acct-row' + (confirming ? ' confirming' : '')}>
      <div className="acct-main">
        <span className="acct-name">{a.login}</span>
        <span className="acct-note">{a.host}</span>
        {a.default && (
          <span className="acct-badge fable" title={DEFAULT_TITLE}>
            DEFAULT
          </span>
        )}
        {a.status === 'expired' && <span className="acct-status expired">NEEDS SIGN-IN AGAIN</span>}
        {a.status !== 'expired' && a.checkError === 'offline' && (
          <span className="acct-status stale">CAN’T CHECK · OFFLINE</span>
        )}
        {a.status === 'expired' && (
          <button
            className="acct-relogin"
            title="Sign in to this account again"
            onClick={onRelogin}
          >
            Sign in again
          </button>
        )}
        {!a.default && (
          <button className="acct-relogin" title={DEFAULT_TITLE} onClick={onMakeDefault}>
            Make default
          </button>
        )}
        <button className="acct-x" title="Remove account from this Mac" onClick={onAskRemove}>
          <LuX size={12} />
        </button>
      </div>
      {confirming && (
        <div className="acct-confirm">
          <span>
            Remove <b>{a.login}</b> ({a.host}) from this Mac?
            {used.length > 0 &&
              ` ${workspacesLabel(used.length)} — ${used.join(', ')} — go back to your own git setup.`}
          </span>
          <button className="mini danger" onClick={onRemove}>
            Remove
          </button>
          <button className="mini" onClick={onCancelRemove}>
            Cancel
          </button>
        </div>
      )}
      <div className="acct-meters">
        <span className="acct-note">{rowNote(a)}</span>
      </div>
    </div>
  )
}

function GitLoginBox({
  again,
  progress,
  onRetry,
  onToken,
  onClose
}: {
  again?: string
  progress: GitLoginProgress
  onRetry(): void
  onToken(): void
  onClose(): void
}): JSX.Element {
  const useToken = (
    <div>
      <button
        className="ob-link"
        title="Paste a token for GitHub instead of signing in"
        onClick={onToken}
      >
        Use a token instead
      </button>
    </div>
  )
  return (
    <div className="acct-add">
      <div className="acct-add-title">
        {again ? `Sign in again ${again}` : 'Add GitHub account'}
      </div>
      {progress.phase === 'failed' ? (
        <div className="acct-login-state bad">
          <div>Sign-in did not complete.</div>
          <pre className="acct-login-tail">{progress.message}</pre>
          <div className="acct-add-actions" style={{ justifyContent: 'flex-start' }}>
            <button className="mini" onClick={onRetry}>
              Try again
            </button>
          </div>
          {useToken}
        </div>
      ) : (
        <div className="acct-login-state">
          {progress.phase === 'code' && (
            <>
              <div>GitHub opened in your browser. Enter this code there:</div>
              <div className="acct-foot">
                <span className="acct-name">{progress.code}</span>
                <button
                  className="mini"
                  onClick={() => navigator.clipboard?.writeText(progress.code).catch(() => {})}
                >
                  <LuCopy size={14} /> Copy
                </button>
                <button className="mini" onClick={() => window.api.gitAccounts.loginBrowser()}>
                  <LuExternalLink size={14} /> Open page again
                </button>
                <button
                  className="mini"
                  title="Copies the sign-in page's address, to paste into a private window"
                  onClick={() => navigator.clipboard?.writeText(progress.url).catch(() => {})}
                >
                  <LuCopy size={14} /> Copy link
                </button>
              </div>
              <span className="field-hint">
                Signing in through GitHub CLI, the same way as <code>gh auth login</code>.
              </span>
              <span className="field-hint">
                Adding a different GitHub account? Switch to it on github.com first (your picture ▸
                Switch account), or paste the link into a private window. Your other account stays
                signed in.
              </span>
            </>
          )}
          <div>
            <LuLoaderCircle size={14} /> Waiting for GitHub…
          </div>
          {useToken}
        </div>
      )}
      <div className="acct-add-actions">
        <button className="mini" onClick={onClose}>
          Cancel
        </button>
      </div>
      <span className="field-hint">
        Koloft runs the bundled GitHub CLI sign-in for you — no terminal tab. When you approve, the
        account shows up above. Kept on this Mac only.
      </span>
    </div>
  )
}

function GitTokenBox({ why, onClose }: { why?: string; onClose(): void }): JSX.Element {
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.api.gitAccounts.addToken(secret.trim())
    setBusy(false)
    // ADR-0002
    setSecret('')
    if (r.ok) onClose()
    else setError(tokenError(r))
  }

  return (
    <div className="acct-add">
      <div className="acct-add-title">Add GitHub account</div>
      {why && <span className="field-hint">{why}</span>}
      <input
        type="password"
        placeholder="Paste a token (ghp_…)"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        autoFocus
      />
      {error && <div className="acct-add-err">{error}</div>}
      <div className="acct-add-actions">
        <button className="mini" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="mini" onClick={() => void save()} disabled={busy || !secret.trim()}>
          {busy ? 'Checking…' : 'Save'}
        </button>
      </div>
      <span className="field-hint">
        <button className="ob-link" onClick={() => window.api.preview.osOpen(CREATE_TOKEN_URL)}>
          Create a token
        </button>{' '}
        opens github.com — tick <code>{GITHUB_SCOPES}</code>, then paste it here. Koloft checks it,
        reads your username from it, and keeps it on this Mac only.
      </span>
    </div>
  )
}
