import { Fragment, useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { IconClose, IconPlus, IconReload, IconWebPage } from '../../icons'
import type {
  AccountKind,
  AccountView,
  BackendId,
  LoginProgress,
  SignInProgress
} from '@shared/types'
import { SIGN_IN_FOLDER_KINDS } from '@shared/types'
import { backendAvailable } from '@shared/sessionBackend'
import {
  AGENT_IDS,
  accountKindFacts,
  agentManifest,
  agentOfAccountKind,
  signInKindOf,
  type AgentId
} from '@core/agent/registry'
import { agentUi } from '@agents/uis'
import { useStore } from '../../store'
import { useInstalledBackends } from '../../useInstalledBackends'
import { ACCOUNT_KINDS_OF, needsSignInAgain } from '@shared/accountUsage'
import { ageLabel } from '../accountMeter'
import { PaneBadges, PaneUsage, usageOf } from '../usageFromShape'
import { GitAccountsSection } from './GitAccountsSection'
import { Switch } from './Switch'
import { useEscConsumer } from './escScope'
import { useSettingsUpdate } from './useSettingsUpdate'
import '../../accounts.css'

const REFRESH_DONE_LABEL_BEAT_MS = 2500
const INVALID_ACCOUNT_NAME = 'Invalid name: [A-Za-z0-9._-] only, 32 characters max'

export type PaneForm = { signIn: AccountKind; again?: string } | { paste: AccountKind }

export const loginRunning = (progress: LoginProgress | null): boolean =>
  progress !== null && progress.phase !== 'failed'

const scrollIntoViewOnOpen = (form: HTMLDivElement | null): void =>
  form?.scrollIntoView({ block: 'nearest' })

const agentOf = (kind: AccountKind): AgentId => agentOfAccountKind(kind)!

const openSignInTabOf = (
  open: (tab: { tabId: string; cwd: string }, title: string) => void,
  progress: SignInProgress,
  title: string
): void => {
  if (progress.tab) open({ tabId: progress.tab.tabId, cwd: progress.tab.cwd ?? '' }, title)
}

export function AccountsPane(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const login = useStore((s) => s.accountLogin)
  const beginLogin = useStore((s) => s.beginLogin)
  const clearLogin = useStore((s) => s.clearLogin)
  const failed = useSignInFailure()
  const update = useSettingsUpdate()

  const [accounts, setAccounts] = useState<AccountView[]>([])
  // ADR-0002
  const [form, setForm] = useState<PaneForm | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [removeFailed, setRemoveFailed] = useState<string | null>(null)
  const [refresh, setRefresh] = useState<'idle' | 'busy' | 'done'>('idle')
  const refreshBeat = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(refreshBeat.current), [])
  const backgroundLoginRunning = !!login && loginRunning(login.progress)
  const dismissFailure = (): void => {
    if (failed) window.api.accounts.endSignIn(failed.kind, failed.name)
  }
  const openForm = (next: PaneForm): void => {
    if (login && !backgroundLoginRunning) clearLogin()
    dismissFailure()
    setForm(next)
  }
  const openBackgroundSignIn = (kind: AccountKind, again?: string): void => {
    if (backgroundLoginRunning) return
    dismissFailure()
    setForm(null)
    beginLogin(kind, again)
  }
  const openSignIn = (kind: AccountKind, again?: string): void => {
    if (agentUi(agentOf(kind)).accounts.signIn.inATab) openForm({ signIn: kind, again })
    else openBackgroundSignIn(kind, again)
  }
  const signIn = form && 'signIn' in form ? form : null
  const adding = form && 'paste' in form ? form.paste : null

  useEffect(() => {
    let alive = true
    const apply = (next: AccountView[]): void => {
      if (alive) setAccounts(next)
    }
    const off = window.api.accounts.onUpdate(apply)
    void window.api.accounts.list().then(apply)
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

  const row = (a: AccountView): JSX.Element => {
    const key = `${a.kind}:${a.name}`
    return (
      <AccountRow
        key={key}
        account={a}
        confirming={confirmDel === key}
        onToggle={(en) => {
          setAccounts((cur) =>
            cur.map((x) => (x.kind === a.kind && x.name === a.name ? { ...x, enabled: en } : x))
          )
          void window.api.accounts.toggle(a.name, a.kind, en)
        }}
        removeFailed={removeFailed === key}
        onAskRemove={() => {
          setRemoveFailed(null)
          setConfirmDel(key)
        }}
        onCancelRemove={() => setConfirmDel(null)}
        onRemove={async () => {
          setConfirmDel(null)
          setRemoveFailed(null)
          if (await window.api.accounts.remove(a.name, a.kind).catch(() => false)) return
          setRemoveFailed(key)
          setConfirmDel(key)
        }}
        onRelogin={
          accountKindFacts(a.kind).signsInThroughABrowser
            ? () => openSignIn(a.kind, a.name)
            : undefined
        }
      />
    )
  }

  const section = (agent: BackendId): JSX.Element => {
    const kinds = ACCOUNT_KINDS_OF[agent]
    const list = accounts.filter((a) => kinds.includes(a.kind))
    const words = agentUi(agent).accounts
    const signInKind = signInKindOf(agent).id as AccountKind
    return (
      <div className="acct-section">
        {list.length === 0 ? (
          <div className="acct-empty">{words.emptyLine}</div>
        ) : (
          <div className="acct-list">{list.map(row)}</div>
        )}
        <div className="acct-foot">
          <button
            className="mini"
            onClick={() => openSignIn(signInKind)}
            title={words.signIn.buttonTitle}
          >
            <IconWebPage size={14} />
            {` ${words.signIn.button}`}
          </button>
          <button className="mini" onClick={() => openForm({ paste: signInKind })}>
            <IconPlus size={14} />
            {` ${words.signIn.pasteButton}`}
          </button>
        </div>
        {login && agentOf(login.kind) === agent && <LoginDialog key={login.reauthName ?? ''} />}
        {signIn && agentOf(signIn.signIn) === agent ? (
          <SignInDialog
            key={signIn.again ?? ''}
            kind={signIn.signIn}
            again={signIn.again}
            onClose={() => setForm(null)}
          />
        ) : (
          failed && agentOf(failed.kind) === agent && <SignInFailedCard failed={failed} />
        )}
        {adding && kinds.includes(adding) && (
          <AddAccountDialog key={adding} kind={adding} onClose={() => setForm(null)} />
        )}
      </div>
    )
  }

  const runRefresh = async (): Promise<void> => {
    clearTimeout(refreshBeat.current)
    setRefresh('busy')
    try {
      setAccounts(await window.api.accounts.probe())
    } finally {
      setRefresh('done')
      refreshBeat.current = setTimeout(() => setRefresh('idle'), REFRESH_DONE_LABEL_BEAT_MS)
    }
  }

  return (
    <>
      <div className="set-ph">
        <h3>Accounts</h3>
        <p>
          Every session in Koloft runs on an account from its agent’s section below, never on the
          login already on this Mac. Each new session picks its agent’s least-used sign-in, and an
          API key only when every sign-in is at its limit.
        </p>
      </div>

      <div className="set-row">
        <div className="set-lab">
          <b>Skip permission prompts</b>
          <small>
            Adds <code>--dangerously-skip-permissions</code> to Claude and Antigravity when Koloft
            injects an account, and starts new Codex sessions with{' '}
            <code>-a never -s danger-full-access</code> — never overrides permission flags you pass
            yourself.
          </small>
        </div>
        <Switch
          checked={settings.skipPermissions}
          onChange={(on) =>
            update(
              on
                ? { skipPermissions: true, skipPermissionsAgreed: true }
                : { skipPermissions: false }
            )
          }
        />
      </div>
      <div className="set-row">
        <div className="set-lab">
          <b>Account usage</b>
          <small>
            Reads again, right now, how much every enabled account of every agent has used.
          </small>
        </div>
        <button className="mini" disabled={refresh === 'busy'} onClick={() => void runRefresh()}>
          <IconReload size={14} />{' '}
          {refresh === 'busy' ? 'Refreshing…' : refresh === 'done' ? '✓ Updated' : 'Refresh usage'}
        </button>
      </div>

      {AGENT_IDS.map((agent) => (
        <Fragment key={agent}>
          <div className="set-grp">{agentManifest(agent).name}</div>
          {agentUi(agent).accounts.ownSettingRows.map((own) => (
            <div className="set-row" key={own.setting}>
              <div className="set-lab">
                <b>{own.title}</b>
                <small>{own.note}</small>
              </div>
              <Switch
                checked={settings[own.setting]}
                onChange={(on) => update({ [own.setting]: on })}
              />
            </div>
          ))}
          {section(agent)}
        </Fragment>
      ))}
      <GitAccountsSection />
    </>
  )
}

export function LoginDialog(): JSX.Element | null {
  const login = useStore((s) => s.accountLogin)
  const addTab = useStore((s) => s.addTab)
  const showSignInTab = useStore((s) => s.showSignInTab)
  const beginLogin = useStore((s) => s.beginLogin)
  const setLoginProgress = useStore((s) => s.setLoginProgress)
  const clearLogin = useStore((s) => s.clearLogin)
  const [name, setName] = useState(login?.reauthName ?? '')
  const [error, setError] = useState<string | null>(null)
  if (!login) return null
  const { kind, reauthName, progress } = login
  const command = agentManifest(agentOf(kind)).signInCommand

  const start = async (): Promise<void> => {
    setError(null)
    const nm = name.trim()
    setLoginProgress({ phase: 'starting', name: nm })
    const r = await window.api.accounts.beginSignIn(kind, nm, !!reauthName)
    if (!r.ok) {
      beginLogin(kind, reauthName)
      setError(
        r.error === 'invalid-name'
          ? INVALID_ACCOUNT_NAME
          : r.error === 'duplicate'
            ? 'A subscription account already has that name'
            : 'Could not start sign-in'
      )
    }
  }

  const cancel = (): void => {
    window.api.accounts.endSignIn(kind, name.trim())
    clearLogin()
  }

  const showTerminal = (): void => {
    if (!progress?.tabId) return
    showSignInTab(progress.tabId)
    addTab({
      id: progress.tabId,
      kind: 'shell',
      title: `Sign in: ${progress.name}`,
      cwd: progress.cwd ?? '',
      alive: true
    })
    clearLogin()
  }

  const running = loginRunning(progress)

  return (
    <div className="acct-add" ref={scrollIntoViewOnOpen}>
      <div className="acct-add-title">{reauthName ? `Sign in again ${reauthName}` : 'Sign in'}</div>
      {!running && (
        <input
          type="text"
          placeholder="Name this account (e.g. work)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          autoFocus={!reauthName}
          readOnly={!!reauthName}
        />
      )}

      {progress?.phase === 'starting' && (
        <div className="acct-login-state">
          Running <code>{command}</code>…
        </div>
      )}
      {progress?.phase === 'browser' && (
        <div className="acct-login-state">
          <div>
            Finish the authorization in your browser — the token is collected automatically.
          </div>
          {progress.url && (
            <button className="mini" onClick={() => window.api.os.open(progress.url as string)}>
              Open authorization page
            </button>
          )}
        </div>
      )}
      {progress?.phase === 'saved' && (
        <div className="acct-login-state ok">
          ✓ Saved {progress.name} — the account joined the pool
        </div>
      )}
      {progress?.phase === 'failed' && (
        <div className="acct-login-state bad">
          <div>Sign-in did not complete.</div>
          {progress.tail && <pre className="acct-login-tail">{progress.tail}</pre>}
          <div className="acct-add-actions" style={{ justifyContent: 'flex-start' }}>
            <button className="mini" onClick={showTerminal} disabled={!progress.tabId}>
              Show terminal
            </button>
            <button className="mini" onClick={() => beginLogin(kind, reauthName)}>
              Try again
            </button>
          </div>
        </div>
      )}

      {error && <div className="acct-add-err">{error}</div>}
      {!running && progress?.phase !== 'failed' && (
        <div className="acct-add-actions">
          <button className="mini" onClick={clearLogin}>
            Cancel
          </button>
          <button className="mini" onClick={() => void start()} disabled={!name.trim()}>
            Sign in
          </button>
        </div>
      )}
      {running && progress?.phase !== 'saved' && (
        <div className="acct-add-actions">
          <button className="mini" onClick={cancel}>
            Cancel sign-in
          </button>
        </div>
      )}

      <span className="field-hint">
        Koloft runs the official <code>{command}</code> in the <b>background</b> — no terminal tab.
        Once you authorize in the browser, the token goes straight into your Keychain and the
        account joins the pool: no copy-paste, and you never leave this panel.
        {reauthName &&
          ' The new token replaces the existing entry; this row keeps its place and its enabled state.'}
      </span>
    </div>
  )
}

export function useSignInFailure(): SignInProgress | null {
  const [failure, setFailure] = useState<SignInProgress | null>(null)
  useEffect(() => {
    let alive = true
    const off = window.api.accounts.onSignInProgress((news) => setFailure(news.heldFailure))
    void window.api.accounts.heldSignInFailure().then((f) => {
      if (alive) setFailure(f)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return failure
}

export function SignInFailedDialog(): JSX.Element | null {
  const failed = useSignInFailure()
  return failed && <SignInFailedCard failed={failed} />
}

export function SignInFailedCard({ failed }: { failed: SignInProgress }): JSX.Element {
  return (
    <SignInDialog
      key={`${failed.kind}:${failed.name}`}
      kind={failed.kind}
      again={failed.again ? failed.name : undefined}
      failed={failed}
      onClose={() => window.api.accounts.endSignIn(failed.kind, failed.name)}
    />
  )
}

export function SignInDialog({
  kind,
  again,
  failed,
  onClose
}: {
  kind: AccountKind
  again?: string
  failed?: SignInProgress
  onClose(): void
}): JSX.Element {
  const openSignInTab = useStore((s) => s.openSignInTab)
  const [name, setName] = useState(again ?? failed?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { installed } = useInstalledBackends()
  const agent = agentOf(kind)
  const { name: label, signInCommand: command } = agentManifest(agent)
  const signIn = agentUi(agent).accounts.signIn
  const installsFirst = installed !== null && !backendAvailable(installed, agent)

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const nm = name.trim()
    const r = await window.api.accounts.beginSignIn(kind, nm, !!again)
    setBusy(false)
    if (!r.ok) {
      setError(
        r.error === 'invalid-name'
          ? INVALID_ACCOUNT_NAME
          : r.error === 'keychain'
            ? 'Koloft could not clear an old Keychain credential under that name. Try again.'
            : `A ${label} account already has that name`
      )
      return
    }
    openSignInTabOf(openSignInTab, r.progress, `${label} sign in: ${nm}`)
    onClose()
  }

  return (
    <div className="acct-add" ref={failed ? undefined : scrollIntoViewOnOpen}>
      <div className="acct-add-title">
        {again ? `Sign in again ${again}` : `Sign in to ${label}`}
      </div>
      <input
        type="text"
        placeholder="Name this account (e.g. work)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        spellCheck={false}
        autoFocus={!again}
        readOnly={!!again}
      />
      {failed && (
        <div className="acct-login-state bad">
          <div>Sign-in did not complete.</div>
          {failed.tail && <pre className="acct-login-tail">{failed.tail}</pre>}
        </div>
      )}
      {error && <div className="acct-add-err">{error}</div>}
      <div className="acct-add-actions">
        <button className="mini" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="mini" onClick={() => void start()} disabled={busy || !name.trim()}>
          {failed ? 'Try again' : 'Sign in'}
        </button>
      </div>
      <span className="field-hint">
        Koloft opens a terminal tab that runs <code>{command}</code> for this account only.
        {installsFirst && ` ${label} is not on this Mac yet, so the tab installs it first.`} Finish
        the sign-in there; the tab closes itself when <code>{command}</code> ends. Signed in, the
        account joins the pool; if not, this page says so. {signIn.inATab && signIn.hintEnd}
      </span>
    </div>
  )
}

function AccountRow({
  account: a,
  confirming,
  removeFailed,
  onToggle,
  onAskRemove,
  onCancelRemove,
  onRemove,
  onRelogin
}: {
  account: AccountView
  confirming: boolean
  removeFailed: boolean
  onToggle(enabled: boolean): void
  onAskRemove(): void
  onCancelRemove(): void
  onRemove(): void
  onRelogin?: () => void
}): JSX.Element {
  const now = Date.now()
  const shape = usageOf(a, now)
  const stale = shape.ageShownFrom !== null ? ageLabel(shape.ageShownFrom, now) : null
  return (
    <div className={'acct-row' + (a.enabled ? '' : ' off') + (confirming ? ' confirming' : '')}>
      <div className="acct-main">
        <Switch
          small
          checked={a.enabled}
          onChange={onToggle}
          title={a.enabled ? 'In the pool' : 'Out of the pool'}
        />
        <span className="acct-name">{a.name}</span>
        <PaneBadges u={shape} />
        {a.status === 'expired' && (
          <span className="acct-status expired">EXPIRED · out of pool</span>
        )}
        {a.status === 'unverified' && <span className="acct-status unverified">UNVERIFIED</span>}
        {stale && <span className="acct-status stale">{stale}</span>}
        {needsSignInAgain(a) && onRelogin && (
          <button
            className="acct-relogin"
            onClick={onRelogin}
            title="Run the browser sign-in again"
          >
            Sign in again
          </button>
        )}
        <button className="acct-x" title="Delete account" onClick={onAskRemove}>
          <IconClose size={12} />
        </button>
      </div>
      {confirming && (
        <div className="acct-confirm">
          <span>
            {removeFailed ? (
              <span className="acct-login-state bad">
                Koloft could not remove its Keychain credential, so the account is kept. Delete
                again to retry.
              </span>
            ) : SIGN_IN_FOLDER_KINDS.includes(a.kind) ? (
              <>
                Delete <b>{a.name}</b>? Its sign-in folder stays on disk, so its sessions stay in
                your history.
              </>
            ) : (
              <>
                Delete <b>{a.name}</b> and remove its Keychain credential?
              </>
            )}
          </span>
          <button className="mini danger" onClick={onRemove}>
            Delete
          </button>
          <button className="mini" onClick={onCancelRemove}>
            Cancel
          </button>
        </div>
      )}
      <PaneUsage u={shape} />
    </div>
  )
}

export function AddAccountDialog({
  kind,
  onClose
}: {
  kind: AccountKind
  onClose(): void
}): JSX.Element {
  const [name, setName] = useState('')
  const [secret, setSecret] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const openSignInTab = useStore((s) => s.openSignInTab)
  const facts = accountKindFacts(kind)
  const agent = agentManifest(agentOf(kind))
  const words = agentUi(agentOf(kind)).accounts
  const form = words.pasteForms[kind]

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.api.accounts.add(
      name.trim(),
      kind,
      secret,
      facts.takesAnEndpoint
        ? { baseUrl: baseUrl.trim(), model: model.trim() || undefined }
        : undefined
    )
    // ADR-0002
    setSecret('')
    if (facts.asksItsFirstRunQuestionsForEachAccount && r.account && r.account.status !== 'ok') {
      const setup = await window.api.accounts.beginSignIn(kind, r.account.name, true)
      setBusy(false)
      if (!setup.ok) {
        setError(`Saved, but ${agent.command} could not be opened — use Sign in again on its row`)
        return
      }
      openSignInTabOf(openSignInTab, setup.progress, `${agent.name} sign in: ${r.account.name}`)
      onClose()
      return
    }
    setBusy(false)
    if (r.ok || r.account) {
      onClose()
    } else {
      setError(
        r.error === 'invalid-name'
          ? INVALID_ACCOUNT_NAME
          : r.error === 'duplicate'
            ? 'An account of this kind already has that name'
            : r.error === 'invalid-endpoint'
              ? 'Invalid base URL: must start with http(s)://'
              : 'Could not save'
      )
    }
  }

  return (
    <div className="acct-add" ref={scrollIntoViewOnOpen}>
      <div className="acct-add-title">{form.title}</div>
      <input
        type="text"
        placeholder="Account name (e.g. personal)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        spellCheck={false}
        autoFocus
      />
      {facts.takesAnEndpoint && (
        <>
          <input
            type="text"
            placeholder={words.baseUrlPlaceholders[kind]}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            spellCheck={false}
          />
          <input
            type="text"
            placeholder="Model id (optional — the endpoint default if blank)"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            spellCheck={false}
          />
        </>
      )}
      <input
        type="password"
        placeholder={form.placeholder}
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
      />
      {error && <div className="acct-add-err">{error}</div>}
      <div className="acct-add-actions">
        <button className="mini" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className="mini"
          onClick={() => void save()}
          disabled={
            busy || !name.trim() || !secret.trim() || (facts.takesAnEndpoint && !baseUrl.trim())
          }
        >
          {SIGN_IN_FOLDER_KINDS.includes(kind)
            ? busy
              ? 'Saving…'
              : 'Save'
            : busy
              ? 'Verifying…'
              : 'Verify and save'}
        </button>
      </div>
      <span className="field-hint">
        {form.hint}
        {facts.takesAnEndpoint &&
          ' A custom endpoint exposes no quota to measure, so it is used only when every ' +
            'subscription is rate-limited — and it switches the session to that endpoint’s own model.'}
      </span>
    </div>
  )
}
