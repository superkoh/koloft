import { useEffect, useRef, useState, type JSX } from 'react'
import { LuX } from 'react-icons/lu'
import { BACKEND_LABEL, backendAvailable, SESSION_BACKENDS } from '@shared/sessionBackend'
import { channelLabel, GLOBAL_SCOPE, scopeName } from '@shared/conductors'
import type { BackendAvailability, BackendId, DiscordChannel } from '@shared/types'
import { useStore } from '../store'
import { shortenHome } from '../browseModel'
import { SessionBackendIcon } from './SessionBackendIcon'

export function BindConductorDialog(): JSX.Element | null {
  const request = useStore((s) => s.bindConductor)
  if (!request) return null
  return <BindForm key={request.editId ?? request.scope ?? ''} {...request} />
}

function BindForm({ scope, editId }: { scope?: string; editId?: string }): JSX.Element {
  const bindings = useStore((s) => s.settings.discord.bindings)
  const methods = useStore((s) => s.settings.sessionMethods)
  const workspaceRows = useStore((s) => s.workspaceRows)
  const setBindConductor = useStore((s) => s.setBindConductor)
  const editing = editId ? bindings.find((b) => b.id === editId) : undefined
  const scopes = editing
    ? [editing.scope]
    : [GLOBAL_SCOPE, ...workspaceRows.map((w) => w.workspace.path)]
  const takenBy = (s: string) => bindings.find((b) => b.scope === s && b.id !== editId)
  const [picked, setPicked] = useState<string | undefined>(
    editing?.scope ?? (scope && !takenBy(scope) ? scope : scopes.find((s) => !takenBy(s)))
  )
  const [detected, setDetected] = useState<BackendAvailability[] | null>(null)
  const issue = (b: BackendId): string | undefined => {
    if (!methods.enabled[b]) return 'Disabled in Settings ▸ Sessions'
    if (detected && !backendAvailable(detected, b)) return 'Not installed'
    return undefined
  }
  const [backend, setBackend] = useState<BackendId>(
    editing?.backend ??
      (methods.enabled[methods.defaultBackend] ? methods.defaultBackend : 'claude')
  )
  const [channels, setChannels] = useState<DiscordChannel[] | null>(null)
  const [channel, setChannel] = useState<DiscordChannel | undefined>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const close = (): void => setBindConductor(null)
  const channelTakenBy = (c: DiscordChannel) =>
    bindings.find((b) => b.channel.channelId === c.channelId && b.id !== editId)
  const editedChannelId = editing?.channel.channelId

  useEffect(() => {
    let alive = true
    void window.api.sessions.backends().then((list) => {
      if (alive) setDetected(list)
    })
    window.api.discord.channels().then(
      (list) => {
        if (!alive) return
        setChannels(list)
        setChannel(list.find((c) => c.channelId === editedChannelId))
      },
      () => {
        if (alive) setChannels([])
      }
    )
    return () => {
      alive = false
    }
  }, [editedChannelId])

  const submitRef = useRef<() => Promise<void>>(async () => undefined)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault()
        void submitRef.current()
        return
      }
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setBindConductor(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setBindConductor])

  const submit = async (): Promise<void> => {
    if (busy || !picked) return
    if (!channel) return setError('Pick a channel.')
    const unusable = issue(backend)
    if (unusable) return setError(unusable)
    setBusy(true)
    const r = await window.api.conductors.save({ id: editId, scope: picked, backend, channel })
    setBusy(false)
    if (r.ok) close()
    else setError(r.error)
  }
  submitRef.current = submit

  const title = editing ? 'Change Discord channel' : 'Bind a Discord channel'

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal worktreesess"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>{title}</span>
          <span className="modal-close" onClick={close} aria-label="Close">
            <LuX size={16} />
          </span>
        </div>
        <div className="modal-body">
          <span className="flabel">Scope</span>
          <div className="wt-list">
            {scopes.map((s) => {
              const taken = takenBy(s)
              return (
                <div
                  key={s}
                  className={'cb-row' + (taken ? ' dim' : '') + (s === picked ? ' hot' : '')}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (taken) return
                    setPicked(s)
                    setError('')
                  }}
                >
                  <span className="wt-name">{scopeName(s)}</span>
                  <span className="note">
                    {taken
                      ? `already bound · ${channelLabel(taken)}`
                      : s === GLOBAL_SCOPE
                        ? 'all workspaces'
                        : shortenHome(s, window.api.home)}
                  </span>
                </div>
              )
            })}
          </div>
          <span className="flabel">Conductor</span>
          <div className="field-check-row">
            <div className="seg" role="group" aria-label="Conductor method">
              {SESSION_BACKENDS.map((b) => (
                <button
                  key={b}
                  className={backend === b ? 'on' : ''}
                  aria-pressed={backend === b}
                  disabled={!!issue(b)}
                  title={issue(b)}
                  onClick={() => {
                    setBackend(b)
                    setError('')
                  }}
                >
                  <SessionBackendIcon backend={b} size={14} decorative />
                  {BACKEND_LABEL[b]}
                </button>
              ))}
            </div>
          </div>
          <span className="flabel">Channel</span>
          {channels && channels.length > 0 && (
            <div className="wt-list">
              {channels.map((c) => {
                const taken = channelTakenBy(c)
                return (
                  <div
                    key={c.channelId}
                    className={
                      'cb-row' +
                      (taken ? ' dim' : '') +
                      (c.channelId === channel?.channelId ? ' hot' : '')
                    }
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (taken) return
                      setChannel(c)
                      setError('')
                    }}
                  >
                    <span className="wt-name">#{c.name}</span>
                    {taken && <span className="note">bound to {scopeName(taken.scope)}</span>}
                  </div>
                )
              })}
            </div>
          )}
          <p className={'field-hint' + (error ? ' bad' : '')}>
            {error ||
              (channels === null
                ? 'Loading your channels…'
                : channels.length === 0
                  ? 'No channels yet. Finish Settings ▸ Discord ▸ Set up Discord… first.'
                  : 'Channels come from your server through the bot. Each workspace binds one channel; the global conductor binds one.')}
          </p>
        </div>
        <div className="modal-foot">
          <button className="mini" onMouseDown={(e) => e.preventDefault()} onClick={close}>
            Cancel
          </button>
          <button
            className="btn-primary"
            data-default="true"
            disabled={busy || !picked}
            onClick={() => void submit()}
          >
            {editing ? 'Save' : 'Bind'}
            <span className="k">⏎</span>
          </button>
        </div>
      </div>
    </div>
  )
}
