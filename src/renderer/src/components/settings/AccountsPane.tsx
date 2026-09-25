import { useCallback, useEffect, useState, type JSX } from 'react'
import { LuGlobe, LuPlus, LuRefreshCw, LuX } from 'react-icons/lu'
import type { AccountKind, AccountView } from '@shared/types'
import { useStore } from '../../store'
import { windowLabel } from '@shared/accountUsage'
import { Meter, ageLabel, probeErrorLabel, resetLabel } from '../accountMeter'
import { Switch } from './Switch'
import { useEscConsumer } from './escScope'
import { useSettingsUpdate } from './useSettingsUpdate'

const REFRESH_DONE_LABEL_BEAT_MS = 2500
const INVALID_ACCOUNT_NAME = 'Invalid name: [A-Za-z0-9._-] only, 32 characters max'

export function AccountsPane(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const login = useStore((s) => s.accountLogin)
  const beginLogin = useStore((s) => s.beginLogin)
  const update = useSettingsUpdate()
  const multiAccount = settings.multiAccount
  const childRow = 'set-row child' + (multiAccount ? '' : ' off')

  const [accounts, setAccounts] = useState<AccountView[]>([])
  // ADR-0002
  const [adding, setAdding] = useState<AccountKind | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [refresh, setRefresh] = useState<'idle' | 'busy' | 'done'>('idle')
  const [codexSignIn, setCodexSignIn] = useState<{ again?: string } | null>(null)
  const claudeAccounts = accounts.filter((a) => a.kind !== 'codex-home')
  const codexAccounts = accounts.filter((a) => a.kind === 'codex-home')

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
        disabled={!multiAccount}
        confirming={confirmDel === key}
        onToggle={(en) => {
          setAccounts((cur) =>
            cur.map((x) => (x.kind === a.kind && x.name === a.name ? { ...x, enabled: en } : x))
          )
          void window.api.accounts.toggle(a.name, a.kind, en)
        }}
        onAskRemove={() => setConfirmDel(key)}
        onCancelRemove={() => setConfirmDel(null)}
        onRemove={() => {
          setConfirmDel(null)
          void window.api.accounts.remove(a.name, a.kind)
        }}
        onRelogin={
          a.kind === 'oauth'
            ? () => beginLogin(a.name)
            : a.kind === 'codex-home'
              ? () => setCodexSignIn({ again: a.name })
              : undefined
        }
      />
    )
  }

  const section = (list: AccountView[], empty: string, foot: JSX.Element): JSX.Element => (
    <div className={'acct-section' + (multiAccount ? '' : ' disabled')}>
      {list.length === 0 ? (
        <div className="acct-empty">{empty}</div>
      ) : (
        <div className="acct-list">{list.map(row)}</div>
      )}
      <div className="acct-foot">{foot}</div>
    </div>
  )

  const runRefresh = async (): Promise<void> => {
    setRefresh('busy')
    try {
      setAccounts(await window.api.accounts.probe())
    } finally {
      setRefresh('done')
      setTimeout(() => setRefresh('idle'), REFRESH_DONE_LABEL_BEAT_MS)
    }
  }

  return (
    <>
      <div className="set-ph">
        <h3>Claude accounts</h3>
        <p>Every claude launched in Koloft picks the least-used account below.</p>
      </div>

      <div className="set-row">
        <div className="set-lab">
          <b>Multi-account mode</b>
          <small>Off, every new session uses the login already on this Mac.</small>
        </div>
        <Switch
          checked={multiAccount}
          onChange={(on) => update({ multiAccount: on })}
          title="Multi-account mode"
        />
      </div>
      <div className={childRow}>
        <div className="set-lab">
          <b>Skip permission prompts</b>
          <small>
            Adds <code>--dangerously-skip-permissions</code> when Koloft injects an account — never
            overrides permission flags you pass yourself.
          </small>
        </div>
        <Switch
          checked={settings.skipPermissions}
          onChange={(on) => update({ skipPermissions: on })}
          disabled={!multiAccount}
        />
      </div>
      <div className={childRow}>
        <div className="set-lab">
          <b>Prefer accounts with fable allowance</b>
          <small>
            Off, accounts are picked purely by 5h / 7d load — use that when fable is nearly spent
            and one account is taking every session.
          </small>
        </div>
        <Switch
          checked={settings.fablePriority}
          onChange={(on) => update({ fablePriority: on })}
          disabled={!multiAccount}
        />
      </div>

      {section(
        claudeAccounts,
        'No accounts yet — add one below. With the switch on but the pool empty, claude falls back to your system login.',
        <>
          <button
            className="mini"
            disabled={!multiAccount}
            onClick={() => beginLogin()}
            title="Runs claude setup-token in the background and stores the token for you"
          >
            <LuGlobe size={14} /> Sign in
          </button>
          <button className="mini" disabled={!multiAccount} onClick={() => setAdding('oauth')}>
            <LuPlus size={14} /> Paste token
          </button>
          <button
            className="mini acct-refresh"
            disabled={!multiAccount || refresh === 'busy'}
            onClick={() => void runRefresh()}
            title="Probe every enabled account now"
          >
            <LuRefreshCw size={14} />{' '}
            {refresh === 'busy'
              ? 'Refreshing…'
              : refresh === 'done'
                ? '✓ Updated'
                : 'Refresh usage'}
          </button>
        </>
      )}

      <div className="set-grp">Codex</div>
      {section(
        codexAccounts,
        'No Codex accounts yet — with none, Codex uses its own login on this Mac. Each account here is its own Codex sign-in, and every new Codex session picks the least-used one.',
        <button
          className="mini"
          disabled={!multiAccount}
          onClick={() => setCodexSignIn({})}
          title="Runs codex login in a terminal tab for a new Codex account"
        >
          <LuGlobe size={14} /> Sign in to Codex
        </button>
      )}
      {codexSignIn && (
        <CodexSignInDialog again={codexSignIn.again} onClose={() => setCodexSignIn(null)} />
      )}
      {adding && <AddAccountDialog kind={adding} onClose={() => setAdding(null)} />}
      {login && <LoginDialog />}
    </>
  )
}

// CC§7
function LoginDialog(): JSX.Element | null {
  const login = useStore((s) => s.accountLogin)
  const addTab = useStore((s) => s.addTab)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const beginLogin = useStore((s) => s.beginLogin)
  const setLoginProgress = useStore((s) => s.setLoginProgress)
  const clearLogin = useStore((s) => s.clearLogin)
  const [name, setName] = useState(login?.reauthName ?? '')
  const [error, setError] = useState<string | null>(null)
  if (!login) return null
  const reauthName = login.reauthName
  const progress = login.progress

  const start = async (): Promise<void> => {
    setError(null)
    const nm = name.trim()
    setLoginProgress({ phase: 'starting', name: nm })
    const ok = await window.api.accounts.startLogin(nm, !!reauthName)
    if (ok !== 'ok') {
      beginLogin(reauthName)
      setError(
        ok === 'invalid-name'
          ? INVALID_ACCOUNT_NAME
          : ok === 'duplicate'
            ? 'A subscription account already has that name'
            : 'Could not start sign-in'
      )
    }
  }

  const cancel = (): void => {
    window.api.accounts.cancelLogin()
    clearLogin()
  }

  const showTerminal = (): void => {
    if (!progress?.tabId) return
    addTab({
      id: progress.tabId,
      kind: 'shell',
      title: `Sign in: ${progress.name}`,
      cwd: progress.cwd ?? '',
      alive: true
    })
    setSettingsOpen(false)
    clearLogin()
  }

  const running = progress !== null && progress.phase !== 'failed'

  return (
    <div className="acct-add">
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
          Running <code>claude setup-token</code>…
        </div>
      )}
      {progress?.phase === 'browser' && (
        <div className="acct-login-state">
          <div>
            Finish the authorization in your browser — the token is collected automatically.
          </div>
          {progress.url && (
            <button
              className="mini"
              onClick={() => window.api.preview.osOpen(progress.url as string)}
            >
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
            <button className="mini" onClick={() => beginLogin(reauthName)}>
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
        Koloft runs the official <code>claude setup-token</code> in the <b>background</b> — no
        terminal tab. Once you authorize in the browser, the token goes straight into your Keychain
        and the account joins the pool: no copy-paste, and you never leave this panel.
        {reauthName &&
          ' The new token replaces the existing entry; this row keeps its place and its enabled state.'}
      </span>
    </div>
  )
}

// CODEX§15
function CodexSignInDialog({ again, onClose }: { again?: string; onClose(): void }): JSX.Element {
  const addTab = useStore((s) => s.addTab)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [name, setName] = useState(again ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const nm = name.trim()
    const r = await window.api.accounts.codexSignIn(nm, !!again)
    setBusy(false)
    if (!r.ok) {
      setError(
        r.error === 'invalid-name'
          ? INVALID_ACCOUNT_NAME
          : r.error === 'duplicate'
            ? 'A Codex account already has that name'
            : 'Codex is not available on this Mac'
      )
      return
    }
    addTab({
      id: r.tabId,
      kind: 'shell',
      title: `Codex sign in: ${nm}`,
      cwd: r.cwd,
      alive: true
    })
    setSettingsOpen(false)
    onClose()
  }

  return (
    <div className="acct-add">
      <div className="acct-add-title">{again ? `Sign in again ${again}` : 'Sign in to Codex'}</div>
      <input
        type="text"
        placeholder="Name this account (e.g. work)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        spellCheck={false}
        autoFocus={!again}
        readOnly={!!again}
      />
      {error && <div className="acct-add-err">{error}</div>}
      <div className="acct-add-actions">
        <button className="mini" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="mini" onClick={() => void start()} disabled={busy || !name.trim()}>
          Sign in
        </button>
      </div>
      <span className="field-hint">
        Koloft opens a terminal tab that runs <code>codex login</code> for this account only. Finish
        the sign-in there; the tab closes itself when it is done and the account joins the pool.
        Your Codex settings and trusted folders are shared by every account.
      </span>
    </div>
  )
}

function AccountRow({
  account: a,
  disabled,
  confirming,
  onToggle,
  onAskRemove,
  onCancelRemove,
  onRemove,
  onRelogin
}: {
  account: AccountView
  disabled: boolean
  confirming: boolean
  onToggle(enabled: boolean): void
  onAskRemove(): void
  onCancelRemove(): void
  onRemove(): void
  onRelogin?: () => void
}): JSX.Element {
  const u = a.usage
  const now = Date.now()
  const measuredAt = u?.at ?? a.limits?.at
  const stale = measuredAt !== undefined ? ageLabel(measuredAt, now) : null
  const needsAuth = a.status === 'expired' || a.status === 'unverified'
  return (
    <div className={'acct-row' + (a.enabled ? '' : ' off') + (confirming ? ' confirming' : '')}>
      <div className="acct-main">
        <Switch
          small
          checked={a.enabled}
          disabled={disabled}
          onChange={onToggle}
          title={a.enabled ? 'In the pool' : 'Out of the pool'}
        />
        <span className="acct-name">{a.name}</span>
        {a.kind === 'apikey' && <span className="acct-badge api">API KEY</span>}
        {a.kind === 'custom' && <span className="acct-badge custom">ENDPOINT</span>}
        {a.kind === 'oauth' && a.fable === 'yes' && (
          <span
            className="acct-badge fable"
            title="Plan includes a fable allowance — fable launches are routed here first"
          >
            FABLE
          </span>
        )}
        {a.kind === 'oauth' && a.fable === 'no' && (
          <span className="acct-badge nofable">FABLE</span>
        )}
        {a.status === 'expired' && (
          <span className="acct-status expired">EXPIRED · out of pool</span>
        )}
        {a.status === 'unverified' && <span className="acct-status unverified">UNVERIFIED</span>}
        {stale && <span className="acct-status stale">{stale}</span>}
        {needsAuth && onRelogin && !disabled && (
          <button
            className="acct-relogin"
            onClick={onRelogin}
            title="Run the browser sign-in again"
          >
            Sign in again
          </button>
        )}
        <button className="acct-x" title="Delete account" onClick={onAskRemove}>
          <LuX size={12} />
        </button>
      </div>
      {confirming && (
        <div className="acct-confirm">
          <span>
            {a.kind === 'codex-home' ? (
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
      {a.kind === 'codex-home' ? (
        <div className="acct-meters">
          {a.status !== 'ok' ? (
            <span className="acct-note">Not signed in — use Sign in again</span>
          ) : a.limits && a.limits.windows.length > 0 ? (
            a.limits.windows.map((w) => (
              <Meter
                key={w.minutes}
                label={windowLabel(w.minutes)}
                v={w.used}
                win={windowLabel(w.minutes)}
              />
            ))
          ) : (
            <span className="acct-note">
              {a.probeError ? probeErrorLabel(a.probeError) : 'Not probed yet'}
            </span>
          )}
          {a.status === 'ok' && a.limits?.windows[0]?.resetsAt ? (
            <span className="acct-note">
              {windowLabel(a.limits.windows[0].minutes)} resets{' '}
              {resetLabel(a.limits.windows[0].resetsAt, now)}
            </span>
          ) : null}
        </div>
      ) : a.kind === 'custom' ? (
        <div className="acct-meters">
          <span className="acct-note">
            {a.baseUrl}
            {a.model ? ` · ${a.model}` : ''} · used only when every subscription is rate-limited
            (switches model)
          </span>
        </div>
      ) : a.kind === 'apikey' ? (
        <div className="acct-meters">
          <span className="acct-note">
            Metered — used only when every subscription is rate-limited
          </span>
        </div>
      ) : u ? (
        <div className="acct-meters">
          <Meter label="5h" v={u.u5} win="5h" />
          <Meter label="7d" v={u.u7} win="7d" />
          {u.hasOi && <Meter label="fable" v={u.uoi} win="oi" soi={u.soi} />}
          {/* CC§7 */}
          {u.r5 > 0 && <span className="acct-note">5h resets {resetLabel(u.r5, now)}</span>}
        </div>
      ) : (
        <div className="acct-meters">
          <span className="acct-note">
            {a.probeError ? probeErrorLabel(a.probeError) : 'Not probed yet'}
          </span>
        </div>
      )}
    </div>
  )
}

function AddAccountDialog({ kind, onClose }: { kind: AccountKind; onClose(): void }): JSX.Element {
  const [name, setName] = useState('')
  const [secret, setSecret] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.api.accounts.add(
      name.trim(),
      kind,
      secret,
      kind === 'custom' ? { baseUrl: baseUrl.trim(), model: model.trim() || undefined } : undefined
    )
    setBusy(false)
    // ADR-0002
    setSecret('')
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

  const title =
    kind === 'oauth' ? 'Paste token' : kind === 'apikey' ? 'Add API key' : 'Add custom endpoint'

  return (
    <div className="acct-add">
      <div className="acct-add-title">{title}</div>
      <input
        type="text"
        placeholder="Account name (e.g. personal)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        spellCheck={false}
      />
      {kind === 'custom' && (
        <>
          <input
            type="text"
            placeholder="Base URL (e.g. https://example.com/api/anthropic)"
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
        placeholder={
          kind === 'oauth'
            ? 'sk-ant-oat01-… (from claude setup-token)'
            : kind === 'apikey'
              ? 'sk-ant-api03-…'
              : 'Key issued by that endpoint'
        }
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
            busy || !name.trim() || !secret.trim() || (kind === 'custom' && !baseUrl.trim())
          }
        >
          {busy ? 'Verifying…' : 'Verify and save'}
        </button>
      </div>
      <span className="field-hint">
        What you paste is used only to verify and to write the Keychain entry — never echoed, never
        written to a file. A failed check still saves the account, marked UNVERIFIED.
        {kind === 'custom' &&
          ' A custom endpoint exposes no quota to measure, so it is used only when every ' +
            'subscription is rate-limited — and it switches the session to that endpoint’s own model.'}
      </span>
    </div>
  )
}
