import { useLayoutEffect, useState, type JSX } from 'react'
import type { AccountView } from '@shared/types'
import { ACCOUNT_KINDS_OF } from '@shared/accountUsage'
import { BACKEND_LABEL, SESSION_BACKENDS } from '@shared/sessionBackend'
import { accountId, workspaceShortName } from '@shared/workspaceAccounts'
import { IconClose } from '../icons'
import { useStore } from '../store'
import { Switch } from './settings/Switch'
import '../cronJobs.css'

function accountNote(a: AccountView): string {
  const what =
    a.kind === 'custom'
      ? `custom endpoint${a.model ? ` · ${a.model}` : ''}`
      : a.kind === 'apikey' || a.apiKey
        ? 'API key'
        : 'sign-in'
  if (!a.enabled) return `${what} · turned off`
  return a.status === 'ok' ? what : `${what} · not signed in`
}

export function WorkspaceAccountsDialog({
  wsPath,
  onClose
}: {
  wsPath: string
  onClose: () => void
}): JSX.Element {
  const accounts = useStore((s) => s.accounts) ?? []
  const saved = useStore((s) => s.settings.workspaceAccounts[wsPath])
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(saved ?? []))
  const title = 'Accounts · ' + workspaceShortName(wsPath)

  // PLATFORM§25
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const flip = (id: string, on: boolean): void => {
    const next = new Set(ticked)
    if (on) next.add(id)
    else next.delete(id)
    setTicked(next)
  }

  const groups = SESSION_BACKENDS.map((backend) => ({
    backend,
    list: accounts.filter((a) => ACCOUNT_KINDS_OF[backend].includes(a.kind))
  })).filter((g) => g.list.length > 0)

  const save = (): void => {
    const shown = groups.flatMap((g) => g.list.map(accountId))
    void window.api.accounts.limitWorkspace(
      wsPath,
      shown.filter((id) => ticked.has(id))
    )
    onClose()
  }

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
          {groups.length === 0 && (
            <p className="field-hint">No accounts yet — add one in Settings ▸ Accounts.</p>
          )}
          {groups.map(({ backend, list }) => (
            <div className="job-list" key={backend}>
              <span className="flabel">{BACKEND_LABEL[backend]}</span>
              {list.map((a) => {
                const id = accountId(a)
                const on = ticked.has(id)
                return (
                  <div className={'job-row' + (on ? ' on' : '')} key={id}>
                    <Switch
                      small
                      checked={on}
                      ariaLabel={`Use ${a.name}`}
                      onChange={(next) => flip(id, next)}
                    />
                    <div className="job-main" onClick={() => flip(id, !on)}>
                      <div className="job-name">{a.name}</div>
                      <div className="job-task">{accountNote(a)}</div>
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
          <button className="btn-primary" data-default="true" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
