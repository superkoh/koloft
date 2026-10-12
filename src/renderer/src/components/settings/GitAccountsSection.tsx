import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { LuCopy, LuExternalLink, LuLoaderCircle, LuPlus, LuX } from 'react-icons/lu'
import {
  GIT_PLATFORMS,
  type GitAccountView,
  type GitLoginProgress,
  type GitPlatform,
  type GitTokenAddResult
} from '@shared/types'
import {
  GIT_PLATFORM_CHIP,
  gitAccountUrl,
  gitHostLabel,
  gitHostOf,
  gitPlatformName,
  gitSignIn
} from '@shared/gitAccountOps'
import { basename } from '@shared/preview'
import { useStore } from '../../store'
import { useEscConsumer } from './escScope'

const DEFAULT_TITLE = 'First choice when a workspace on this host picks an account'

const URL_PLACEHOLDER: Partial<Record<GitPlatform, string>> = {
  ghes: 'Server URL (e.g. https://github.example.com)',
  gitlab: 'Server URL — leave empty for gitlab.com',
  gitea: 'Server URL (e.g. https://codeberg.org)',
  azure: 'Organization URL (e.g. https://dev.azure.com/acme)',
  other: 'Server URL (e.g. https://git.example.com)'
}

const TOKEN_SCOPES: Partial<Record<GitPlatform, string>> = {
  github: 'repo, read:org, gist, workflow',
  ghes: 'repo, read:org, gist, workflow',
  gitlab: 'write_repository, read_api',
  gitea: 'write:repository, read:user',
  azure: 'Code (Read & write)'
}

const TOKEN_PLACEHOLDER: Partial<Record<GitPlatform, string>> = {
  github: 'Paste a token (ghp_…)',
  ghes: 'Paste a token (ghp_…)',
  gitlab: 'Paste a token (glpat-…)'
}

function createTokenUrl(platform: GitPlatform, url: string): string | null {
  switch (platform) {
    case 'github':
    case 'ghes':
      return `${platform === 'github' ? 'https://github.com' : url}/settings/tokens/new?scopes=repo,read:org,gist,workflow&description=Koloft`
    case 'gitlab':
      return `${url}/-/user_settings/personal_access_tokens?name=Koloft&scopes=write_repository,read_api`
    case 'gitea':
      return `${url}/user/settings/applications`
    case 'azure':
      return `${url}/_usersSettings/tokens`
    default:
      return null
  }
}

type AddMode =
  | { step: 'host'; platform: GitPlatform; url: string; error?: string }
  | {
      step: 'login'
      platform: GitPlatform
      url: string
      progress: GitLoginProgress
      again?: string
    }
  | { step: 'token'; platform: GitPlatform; url: string; why?: string }

function workspacesLabel(n: number): string {
  return `${n} workspace${n === 1 ? '' : 's'}`
}

function rowNote(a: GitAccountView): string {
  const used = a.usedBy.length
    ? `used by ${workspacesLabel(a.usedBy.length)}`
    : 'Not used by any workspace yet'
  if (a.status === 'expired') return used
  if (a.platform === 'other') return used.charAt(0).toUpperCase() + used.slice(1)
  const state = a.checkError === 'offline' ? 'Last seen signed in' : 'Signed in'
  return `${state} · ${used.charAt(0).toLowerCase()}${used.slice(1)}`
}

function tokenError(r: GitTokenAddResult, platform: GitPlatform): string | null {
  if (r.ok) return null
  const who = platform === 'github' || platform === 'ghes' ? 'GitHub' : 'The server'
  if (r.error === 'bad-url') return 'That server address does not look right.'
  if (r.error === 'rejected')
    return platform === 'other'
      ? 'Type the username you use on that server.'
      : `${who} turned this token down. Check that you copied all of it and that it has not expired.`
  if (r.error === 'offline')
    return `Could not reach ${who === 'GitHub' ? 'GitHub' : 'the server'}. Check your network and try again.`
  if (r.error === 'missing-scope')
    return `This token lacks the ${r.scope ?? 'needed'} permission. Make a token with ${TOKEN_SCOPES[platform] ?? 'push access'} ticked.`
  return `Could not check this token with ${who === 'GitHub' ? 'GitHub' : 'the server'}.`
}

function startFailure(error: string, platform: GitPlatform): string {
  if (error === 'no-gh') return 'GitHub CLI is not available, so paste a token instead.'
  if (error === 'no-sandbox')
    return 'This Mac cannot run the GitHub CLI sign-in safely, so paste a token instead.'
  if (error === 'no-gcm')
    return `The ${gitPlatformName(platform)} sign-in tool is not available, so paste a token instead.`
  return 'That server address does not look right.'
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
    if (focus === 'git-token') setAdding({ step: 'token', platform: 'github', url: '' })
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

  const begin = async (platform: GitPlatform, raw: string, again?: string): Promise<void> => {
    const url = gitAccountUrl(platform, raw)
    if (!url) {
      setAdding({ step: 'host', platform, url: raw, error: startFailure('bad-url', platform) })
      return
    }
    if (gitSignIn(platform, url) === 'token') {
      setAdding({ step: 'token', platform, url })
      return
    }
    setAdding({ step: 'login', platform, url, progress: { phase: 'checking' }, again })
    const r = await window.api.gitAccounts.loginStart(platform, url)
    if (r.ok) return
    if (r.error === 'busy' || (r.error === 'no-gcm' && platform === 'bitbucket')) {
      const message =
        r.error === 'busy' ? 'Another sign-in is already running.' : startFailure(r.error, platform)
      setAdding({ step: 'login', platform, url, progress: { phase: 'failed', message }, again })
      return
    }
    if (r.error === 'bad-url') {
      setAdding({ step: 'host', platform, url: raw, error: startFailure(r.error, platform) })
      return
    }
    setAdding({ step: 'token', platform, url, why: startFailure(r.error, platform) })
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
                key={a.id}
                account={a}
                confirming={confirmDel === a.id}
                onAskRemove={() => setConfirmDel(a.id)}
                onCancelRemove={() => setConfirmDel(null)}
                onRemove={() => {
                  setConfirmDel(null)
                  void window.api.gitAccounts.remove(a.id)
                }}
                onRelogin={() => void begin(a.platform, a.url, a.login)}
                onMakeDefault={() => void window.api.gitAccounts.makeDefault(a.id)}
              />
            ))}
          </div>
        )}
        <div className="acct-foot">
          <button
            className="mini"
            title="Pick a host, then sign in or paste a token"
            onClick={() => setAdding({ step: 'host', platform: 'github', url: '' })}
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
        <GitHostBox
          mode={adding}
          onChange={(platform, url) => setAdding({ step: 'host', platform, url })}
          onNext={() => void begin(adding.platform, adding.url)}
          onClose={() => setAdding(null)}
        />
      )}
      {adding?.step === 'login' && (
        <GitLoginBox
          mode={adding}
          onRetry={() => void begin(adding.platform, adding.url, adding.again)}
          onToken={() => setAdding({ step: 'token', platform: adding.platform, url: adding.url })}
          onClose={() => setAdding(null)}
        />
      )}
      {adding?.step === 'token' && (
        <GitTokenBox
          platform={adding.platform}
          url={adding.url}
          why={adding.why}
          onClose={() => setAdding(null)}
        />
      )}
    </>
  )
}

function GitHostBox({
  mode,
  onChange,
  onNext,
  onClose
}: {
  mode: AddMode & { step: 'host' }
  onChange(platform: GitPlatform, url: string): void
  onNext(): void
  onClose(): void
}): JSX.Element {
  const placeholder = URL_PLACEHOLDER[mode.platform]
  const urlRequired = !!placeholder && mode.platform !== 'gitlab'
  return (
    <div className="acct-add">
      <div className="acct-add-title">Add account</div>
      <div className="chips">
        {GIT_PLATFORMS.map((p) => (
          <button
            key={p}
            className={'chip' + (p === mode.platform ? ' on' : '')}
            onClick={() => onChange(p, p === mode.platform ? mode.url : '')}
          >
            {GIT_PLATFORM_CHIP[p]}
          </button>
        ))}
      </div>
      {placeholder && (
        <input
          type="text"
          placeholder={placeholder}
          spellCheck={false}
          value={mode.url}
          onChange={(e) => onChange(mode.platform, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (!urlRequired || mode.url.trim())) onNext()
          }}
          autoFocus
        />
      )}
      {mode.error && <div className="acct-add-err">{mode.error}</div>}
      <div className="acct-add-actions">
        <button className="mini" onClick={onClose}>
          Cancel
        </button>
        <button className="mini" onClick={onNext} disabled={urlRequired && !mode.url.trim()}>
          Next
        </button>
      </div>
      <span className="field-hint">
        GitHub, GitLab.com, Bitbucket and Gitea / Forgejo / Codeberg sign in through your browser.
        Azure DevOps, your own GitLab and other servers take a token. The account is kept on this
        Mac only.
      </span>
    </div>
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
        <span className="acct-note">{gitHostLabel(a)}</span>
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
  mode,
  onRetry,
  onToken,
  onClose
}: {
  mode: AddMode & { step: 'login' }
  onRetry(): void
  onToken(): void
  onClose(): void
}): JSX.Element {
  const { progress, again, platform } = mode
  const name = gitPlatformName(platform)
  const viaGh = gitSignIn(platform, mode.url) === 'gh'
  const tokenWorks = platform !== 'bitbucket'
  const useToken = tokenWorks && (
    <div>
      <button
        className="ob-link"
        title={`Paste a token for ${name} instead of signing in`}
        onClick={onToken}
      >
        Use a token instead
      </button>
    </div>
  )
  return (
    <div className="acct-add">
      <div className="acct-add-title">
        {again ? `Sign in again ${again}` : `Add ${name} account`}
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
              <div>A sign-in window opened. Enter this code:</div>
              <div className="acct-foot">
                <span className="acct-name">{progress.code}</span>
                <button
                  className="mini"
                  onClick={() => navigator.clipboard?.writeText(progress.code).catch(() => {})}
                >
                  <LuCopy size={14} /> Copy
                </button>
                <button className="mini" onClick={() => window.api.gitAccounts.loginWindow()}>
                  <LuExternalLink size={14} /> Open window again
                </button>
                <button
                  className="mini"
                  title="Opens the same sign-in page in your default browser"
                  onClick={() => window.api.gitAccounts.loginBrowser()}
                >
                  <LuExternalLink size={14} /> Open in your browser instead
                </button>
              </div>
              <span className="field-hint">
                Signing in through GitHub CLI, the same way as <code>gh auth login</code>.
              </span>
              <span className="field-hint">
                Signed in as someone else there? This window starts signed out, so you can pick any
                account.
              </span>
            </>
          )}
          {progress.phase === 'browser' && viaGh && (
            <>
              <div>A sign-in window opened. Finish signing in there.</div>
              <div className="acct-foot">
                <button className="mini" onClick={() => window.api.gitAccounts.loginWindow()}>
                  <LuExternalLink size={14} /> Open window again
                </button>
                <button
                  className="mini"
                  title="Opens the same sign-in page in your default browser"
                  onClick={() => window.api.gitAccounts.loginBrowser()}
                >
                  <LuExternalLink size={14} /> Open in your browser instead
                </button>
              </div>
            </>
          )}
          {progress.phase === 'browser' && !viaGh && (
            <>
              <div>Finish signing in in your browser.</div>
              <div className="acct-foot">
                <button
                  className="mini"
                  disabled={!progress.url}
                  onClick={() => window.api.gitAccounts.loginBrowser()}
                >
                  <LuExternalLink size={14} /> Open page again
                </button>
                <button
                  className="mini"
                  disabled={!progress.url}
                  onClick={() =>
                    progress.url && navigator.clipboard?.writeText(progress.url).catch(() => {})
                  }
                >
                  <LuCopy size={14} /> Copy link
                </button>
              </div>
              <span className="field-hint">
                Adding a second account on the same site? Sign out of the first one on that site’s
                page in your browser, or copy this link into a private window.
              </span>
            </>
          )}
          <div>
            <LuLoaderCircle size={14} /> Waiting for {name}…
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
        {viaGh
          ? 'Koloft runs the bundled GitHub CLI sign-in for you — no terminal tab. When you approve, the account shows up above. Kept on this Mac only.'
          : `${name} sends you back to Koloft when you are done — no copy-paste. Kept on this Mac only.`}
      </span>
    </div>
  )
}

function GitTokenBox({
  platform,
  url,
  why,
  onClose
}: {
  platform: GitPlatform
  url: string
  why?: string
  onClose(): void
}): JSX.Element {
  const [secret, setSecret] = useState('')
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const host = url ? gitHostOf(url) : 'github.com'
  const name = gitPlatformName(platform)
  const fixedHost = platform === 'github' || !url
  const title = fixedHost ? `Add ${name} account` : `Add account · ${host} (${name})`
  const needsUser = platform === 'other'
  const create = createTokenUrl(platform, url)
  const scopes = TOKEN_SCOPES[platform]

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.api.gitAccounts.addToken({
      platform,
      url,
      token: secret.trim(),
      ...(needsUser && { username: username.trim() })
    })
    setBusy(false)
    // ADR-0002
    setSecret('')
    if (r.ok) onClose()
    else setError(tokenError(r, platform))
  }

  return (
    <div className="acct-add">
      <div className="acct-add-title">{title}</div>
      {why && <span className="field-hint">{why}</span>}
      {needsUser && (
        <input
          type="text"
          placeholder="Your username on that server"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
      )}
      <input
        type="password"
        placeholder={TOKEN_PLACEHOLDER[platform] ?? 'Paste a token'}
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        autoFocus={!needsUser}
      />
      {error && <div className="acct-add-err">{error}</div>}
      <div className="acct-add-actions">
        <button className="mini" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className="mini"
          onClick={() => void save()}
          disabled={busy || !secret.trim() || (needsUser && !username.trim())}
        >
          {busy ? 'Checking…' : 'Save'}
        </button>
      </div>
      <span className="field-hint">
        {create ? (
          <>
            <button className="ob-link" onClick={() => window.api.preview.osOpen(create)}>
              Create a token
            </button>{' '}
            opens {host} — tick <code>{scopes}</code>, then paste it here. Koloft checks it, reads
            your username from it, and keeps it on this Mac only.
          </>
        ) : (
          'Make a token on that server that can push, then paste it here with your username there. Koloft keeps it on this Mac only.'
        )}
      </span>
    </div>
  )
}
