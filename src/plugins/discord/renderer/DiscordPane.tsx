import { useState, type JSX } from 'react'
import { IconPlus } from '@renderer/icons'
import { butlerTitle } from '@plugins/butler/shared/names'
import { channelLabel, setUpWith } from '../shared/channels'
import { ageLabel } from '@shared/freshnessOps'
import { useStore } from '@renderer/store'
import { useNeverSetUp, usePluginStates } from '@renderer/pluginSwitches'
import { plugin } from '../plugin'
import { setUpDiscordWithButler } from './setUpWithButler'
import { openBinding } from './state'
import { messageContentByHand, statusClass, statusText, useDiscordStatus } from './status'
import '@renderer/accounts.css'

export function DiscordPane(): JSX.Element | null {
  const discord = useStore((s) => s.settings.discord)
  const name = useStore((s) => s.settings.butler.name)
  const loaded = useDiscordStatus()
  const [assistError, setAssistError] = useState('')
  const channel = discord.channel

  const neverSetUp = useNeverSetUp(plugin)
  const on = usePluginStates()[plugin.id].on

  const setUpWithButler = async (): Promise<void> => {
    setAssistError((await setUpDiscordWithButler()) ?? '')
  }

  if (!loaded) return null
  const status = loaded
  const candidate = status.candidate
  const setUp = status.phase !== 'off' || !neverSetUp

  return (
    <>
      <div className="set-row">
        <div className="set-lab">
          <b>Let {name} set up Discord</b>
          <small>
            {setUp
              ? `Already set up. Run it again to fix a problem, change the bot or add a server: the steps that are done are skipped.`
              : `Koloft starts a helper for ${name}. The helper opens the Discord website in its Workbench browser and does each step it can. You sign in, type your password and pass the "I am human" checks. Already have a bot? It can use that too.`}
          </small>
        </div>
        <button className="btn-primary" onClick={() => void setUpWithButler()}>
          {setUpWith(name)}
        </button>
      </div>
      {assistError && <div className="acct-login-state bad">{assistError}</div>}

      {setUp && (
        <>
          <div className="set-grp">Bot</div>
          <div className="set-row">
            <div className="set-lab">
              <b>Your Discord account</b>
              <small>Only messages from this user reach {name}.</small>
            </div>
            <span className="acct-note">
              {discord.userId
                ? `You are ${discord.userName ?? discord.userId}${status.appOwner?.id === discord.userId ? ' · owner of the bot’s app' : ''}`
                : status.phase === 'connected'
                  ? 'Send any message in your server'
                  : 'Not set'}
            </span>
          </div>
          {!discord.userId && candidate && (
            <div className="acct-list">
              <div className="acct-row">
                <div className="acct-main">
                  <span className="acct-name">{candidate.name}</span>
                  <span className="acct-note">
                    “{candidate.text}” · {ageLabel(candidate.at, Date.now())}
                  </span>
                  <span className="ob-go">
                    <button className="mini" onClick={() => void window.api.discord.pair(false)}>
                      Not me
                    </button>
                    <button
                      className="btn-primary"
                      onClick={() => void window.api.discord.pair(true)}
                    >
                      This is me
                    </button>
                  </span>
                </div>
              </div>
            </div>
          )}
          <div className="set-row">
            <div className="set-lab">
              <b>Status</b>
              <small>
                {status.phase === 'intents'
                  ? messageContentByHand(name)
                  : 'The bot reads only the bound channel. Koloft keeps the bot’s Message Content on, so it can read what you type.'}
              </small>
            </div>
            {on ? (
              <div className={'acct-login-state' + statusClass(status)}>{statusText(status)}</div>
            ) : (
              <div className="acct-login-state">Off</div>
            )}
          </div>
          <div className="set-row">
            <div className="set-lab">
              <b>Server</b>
              <small>
                {status.phase !== 'connected'
                  ? 'Known once the bot is connected.'
                  : status.guilds.length
                    ? `The bot is in ${status.guilds.map((g) => g.name).join(', ')}.`
                    : `The bot is not in a server you own yet. ${setUpWith(name)} invites it.`}
              </small>
            </div>
          </div>

          <div className="set-grp">Channel</div>
          <div className="acct-section">
            <div className="acct-list">
              {channel && (
                <div className="acct-row">
                  <div className="acct-main">
                    <span className="acct-name">{butlerTitle(name)}</span>
                    <span className="acct-note">{channelLabel(channel)}</span>
                    <button
                      className="acct-x"
                      title="Unbind"
                      onClick={() => void window.api.conductors.unbind()}
                    >
                      Unbind
                    </button>
                  </div>
                  {status.failing[channel.channelId] && (
                    <div className="acct-login-state bad">
                      Cannot post here: {status.failing[channel.channelId]}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="acct-foot">
              <button className="mini" onClick={() => openBinding(true)}>
                {channel ? (
                  'Change channel…'
                ) : (
                  <>
                    <IconPlus size={14} /> Bind a channel…
                  </>
                )}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
