import { useEffect, useLayoutEffect, useState, type JSX } from 'react'
import type { AccountKind, AccountView } from '@shared/types'
import { ACCOUNT_KINDS_OF } from '@shared/accountUsage'
import { BACKEND_LABEL, SESSION_BACKENDS } from '@shared/sessionBackend'
import { accountId, workspaceShortName } from '@shared/workspaceAccounts'
import { IconClose } from '../icons'
import { useStore } from '../store'
import { Switch } from './settings/Switch'
import { ApiKeyBadge } from './accountMeter'
import '../cronJobs.css'
import '../accounts.css'

const CAPTURE_BEFORE_XTERM = true

interface Row {
  id: string
  name: string
  kind: AccountKind
  account?: AccountView
}

function accountNote(row: Row): string {
  const a = row.account
  if (!a) return 'deleted — sessions here stop until you turn it off'
  if (!a.enabled) return 'turned off'
  if (a.status !== 'ok') return 'not signed in'
  return a.kind === 'custom' ? (a.model ?? '') : ''
}

function rowsOf(accounts: AccountView[], saved: readonly string[]): Row[] {
  const listed: Row[] = accounts.map((a) => ({
    id: accountId(a),
    name: a.name,
    kind: a.kind,
    account: a
  }))
  const known = new Set(listed.map((r) => r.id))
  const deleted = saved
    .filter((id) => !known.has(id))
    .map((id) => {
      const cut = id.indexOf(':')
      return { id, kind: id.slice(0, cut) as AccountKind, name: id.slice(cut + 1) }
    })
  return [...listed, ...deleted]
}

export function WorkspaceAccountsDialog({
  wsPath,
  onClose
}: {
  wsPath: string
  onClose: () => void
}): JSX.Element {
  const saved = useStore((s) => s.settings.workspaceAccounts[wsPath])
  const [accounts, setAccounts] = useState<AccountView[] | null>(null)
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(saved ?? []))
  const title = 'Accounts · ' + workspaceShortName(wsPath)

  useEffect(() => {
    let live = true
    void window.api.accounts.list().then((list) => {
      if (live) setAccounts(list)
    })
    return () => {
      live = false
    }
  }, [])

  // PLATFORM§25
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, CAPTURE_BEFORE_XTERM)
    return () => window.removeEventListener('keydown', onKey, CAPTURE_BEFORE_XTERM)
  }, [onClose])

  const flip = (id: string, on: boolean): void => {
    const next = new Set(ticked)
    if (on) next.add(id)
    else next.delete(id)
    setTicked(next)
  }

  const save = (): void => {
    void window.api.accounts.limitWorkspace(wsPath, [...ticked])
    onClose()
  }

  const rows = accounts ? rowsOf(accounts, saved ?? []) : []
  const groups = SESSION_BACKENDS.map((backend) => ({
    backend,
    list: rows.filter((r) => ACCOUNT_KINDS_OF[backend].includes(r.kind))
  })).filter((g) => g.list.length > 0)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal cronjobs"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>{title}</span>
          <span className="modal-close" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </span>
        </div>
        <div className="modal-body">
          <p className="field-hint">
            Sessions in this workspace run only on the accounts ticked here, and switch at a usage
            limit only among them. An agent with nothing ticked uses any of its accounts.
          </p>
          {accounts && groups.length === 0 && (
            <p className="field-hint">No accounts yet — add one in Settings ▸ Accounts.</p>
          )}
          {groups.map(({ backend, list }) => (
            <div className="job-list" key={backend}>
              <span className="flabel">{BACKEND_LABEL[backend]}</span>
              {list.map((row) => {
                const on = ticked.has(row.id)
                const a = row.account
                const note = accountNote(row)
                return (
                  <div className={'job-row' + (on ? ' on' : '')} key={row.id}>
                    <Switch
                      small
                      checked={on}
                      ariaLabel={`Use ${row.name}`}
                      onChange={(next) => flip(row.id, next)}
                    />
                    <div className="job-main" onClick={() => flip(row.id, !on)}>
                      <div className="job-name">
                        {row.name}
                        {a && (a.kind === 'apikey' || a.apiKey) && <ApiKeyBadge />}
                        {row.kind === 'custom' && (
                          <span className="acct-badge custom">ENDPOINT</span>
                        )}
                      </div>
                      {note && <div className="job-task">{note}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <button className="mini" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" data-default="true" disabled={!accounts} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
