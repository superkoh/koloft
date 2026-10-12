import { useEffect, useRef, useState, type JSX } from 'react'
import { LuArrowUpRight, LuPlus, LuX } from 'react-icons/lu'
import {
  channelLabel,
  GLOBAL_SCOPE,
  inviteLink,
  newChannelGuild,
  newChannelName,
  newChannelTopic,
  scopeName
} from '@shared/conductors'
import { distinctName } from '@shared/sessionRoute'
import type { DiscordChannel } from '@shared/types'
import { useStore } from '../store'
import { useDiscordStatus } from '../discordStatus'
import { shortenHome } from '../browseModel'

const NEW = 'new'

export function BindConductorDialog(): JSX.Element | null {
  const request = useStore((s) => s.bindConductor)
  if (!request) return null
  return <BindForm key={request.editId ?? request.scope ?? ''} {...request} />
}

function BindForm({ scope, editId }: { scope?: string; editId?: string }): JSX.Element {
  const bindings = useStore((s) => s.settings.discord.bindings)
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
  const [channels, setChannels] = useState<DiscordChannel[] | null>(null)
  const [channel, setChannel] = useState<DiscordChannel | typeof NEW | undefined>(
    editing ? undefined : NEW
  )
  const [error, setError] = useState<{ text: string; reinvite?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const status = useDiscordStatus()
  const appId = status?.applicationId
  const owner = useStore((s) => s.settings.discord.userId)
  const guildId = newChannelGuild(bindings, status?.guilds ?? [], owner)
  const guildName = status?.guilds.find((g) => g.id === guildId)?.name
  const newName =
    picked &&
    distinctName(
      newChannelName(picked),
      (channels ?? []).filter((c) => c.guildId === guildId).map((c) => c.name)
    )
  const close = (): void => setBindConductor(null)
  const channelTakenBy = (c: DiscordChannel) =>
    bindings.find((b) => b.channel.channelId === c.channelId && b.id !== editId)
  const editedChannelId = editing?.channel.channelId

  useEffect(() => {
    let alive = true
    window.api.discord.channels().then(
      (list) => {
        if (!alive) return
        setChannels(list)
        if (editedChannelId) setChannel(list.find((c) => c.channelId === editedChannelId))
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
    if (!channel || (channel === NEW && !guildId)) return setError({ text: 'Pick a channel.' })
    setBusy(true)
    const input = { id: editId, scope: picked }
    const r =
      channel === NEW
        ? await window.api.conductors.saveWithNewChannel(input)
        : await window.api.conductors.save({ ...input, channel })
    setBusy(false)
    if (r.ok) return close()
    setError({ text: r.error, reinvite: r.cannotMakeChannels })
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
                    setError(null)
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
          <span className="flabel">Channel</span>
          {channels && (guildId || channels.length > 0) && (
            <div className="wt-list">
              {guildId && newName && (
                <div
                  className={'cb-row' + (channel === NEW ? ' hot' : '')}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setChannel(NEW)
                    setError(null)
                  }}
                >
                  <span className="wt-name">
                    <LuPlus size={14} /> New channel #{newName}
                  </span>
                  <span className="note">
                    {picked === GLOBAL_SCOPE
                      ? 'Koloft makes it'
                      : `topic: ${newChannelTopic(picked)}`}
                  </span>
                </div>
              )}
              {channels.map((c) => {
                const taken = channelTakenBy(c)
                return (
                  <div
                    key={c.channelId}
                    className={
                      'cb-row' +
                      (taken ? ' dim' : '') +
                      (channel !== NEW && c.channelId === channel?.channelId ? ' hot' : '')
                    }
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (taken) return
                      setChannel(c)
                      setError(null)
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
            {error ? (
              <>
                {error.text}
                {error.reinvite && appId && (
                  <>
                    {' '}
                    <button
                      className="ob-link"
                      onClick={() => window.api.browser.openExternal(inviteLink(appId))}
                    >
                      Invite the bot again <LuArrowUpRight size={13} />
                    </button>
                  </>
                )}
              </>
            ) : channels === null ? (
              'Loading your channels…'
            ) : !guildId && channels.length === 0 ? (
              'No channels yet. Finish Settings ▸ Discord ▸ Set up Discord… first.'
            ) : channel === NEW && guildId ? (
              <>
                Koloft makes the new channel in your server <b>{guildName}</b>, under your bot’s
                category, and writes the full path in its topic. Or pick a channel you already have.
              </>
            ) : (
              'Channels come from your server through the bot. Each workspace binds one channel; the global Assist binds one.'
            )}
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
