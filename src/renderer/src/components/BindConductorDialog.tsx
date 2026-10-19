import { useEffect, useRef, useState, type JSX } from 'react'
import { IconClose, IconLinkOut, IconPlus } from '../icons'
import { inviteLink, NEW_CHANNEL_NAME, newChannelGuild } from '@shared/conductors'
import { distinctName } from '@shared/sessionRoute'
import type { DiscordChannel } from '@shared/types'
import { useStore } from '../store'
import { useDiscordStatus } from '../discordStatus'

const NEW = 'new'

export function BindConductorDialog(): JSX.Element | null {
  const open = useStore((s) => s.bindButler)
  return open ? <BindForm /> : null
}

function BindForm(): JSX.Element {
  const bindings = useStore((s) => s.settings.discord.bindings)
  const name = useStore((s) => s.settings.butler.name)
  const setBindButler = useStore((s) => s.setBindButler)
  const editing = bindings[0]
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
  const newName = distinctName(
    NEW_CHANNEL_NAME,
    (channels ?? []).filter((c) => c.guildId === guildId).map((c) => c.name)
  )
  const close = (): void => setBindButler(false)
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
      setBindButler(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setBindButler])

  const submit = async (): Promise<void> => {
    if (busy) return
    if (!channel || (channel === NEW && !guildId)) return setError({ text: 'Pick a channel.' })
    setBusy(true)
    const r =
      channel === NEW
        ? await window.api.conductors.bindNewChannel()
        : await window.api.conductors.bind(channel)
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
            <IconClose size={16} />
          </span>
        </div>
        <div className="modal-body">
          <span className="flabel">Channel</span>
          {channels && (guildId || channels.length > 0) && (
            <div className="wt-list">
              {guildId && (
                <div
                  className={'cb-row' + (channel === NEW ? ' hot' : '')}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setChannel(NEW)
                    setError(null)
                  }}
                >
                  <span className="wt-name">
                    <IconPlus size={14} /> New channel #{newName}
                  </span>
                  <span className="note">Koloft makes it</span>
                </div>
              )}
              {channels.map((c) => (
                <div
                  key={c.channelId}
                  className={
                    'cb-row' + (channel !== NEW && c.channelId === channel?.channelId ? ' hot' : '')
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setChannel(c)
                    setError(null)
                  }}
                >
                  <span className="wt-name">#{c.name}</span>
                </div>
              ))}
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
                      Invite the bot again <IconLinkOut size={13} />
                    </button>
                  </>
                )}
              </>
            ) : channels === null ? (
              'Loading your channels…'
            ) : !guildId && channels.length === 0 ? (
              'No channels yet. Finish Settings ▸ Discord ▸ Set up first.'
            ) : channel === NEW && guildId ? (
              <>
                Koloft makes the new channel in your server <b>{guildName}</b>, under your bot’s
                category. Or pick a channel you already have.
              </>
            ) : (
              `Channels come from your server through the bot. You talk to ${name} in the one you pick.`
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
            disabled={busy}
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
