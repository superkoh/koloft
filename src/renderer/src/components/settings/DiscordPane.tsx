import { useState, type JSX } from 'react'
import { IconPlus } from '../../icons'
import { channelLabel, scopeName, SET_UP_WITH_ASSIST } from '@shared/conductors'
import { ageLabel } from '@shared/freshnessOps'
import { useStore } from '../../store'
import { setUpDiscordWithAssist } from '../ConductorsIsland'
import {
  MESSAGE_CONTENT_BY_HAND,
  statusClass,
  statusText,
  useDiscordStatus
} from '../../discordStatus'
import '../../accounts.css'

export function DiscordPane(): JSX.Element {
  const discord = useStore((s) => s.settings.discord)
  const setBindConductor = useStore((s) => s.setBindConductor)
  const loaded = useDiscordStatus()
  const [assistError, setAssistError] = useState('')

  const setUpWithAssist = async (): Promise<void> => {
    setAssistError((await setUpDiscordWithAssist()) ?? '')
  }

  const head = (
    <div className="set-ph">
      <h3>Discord</h3>
      <p>Talk to Assist from Discord. Each Assist is a normal session bound to one channel.</p>
    </div>
  )
  if (!loaded) return head
  const status = loaded
  const candidate = status.candidate
  const setUp = status.phase !== 'off'

  return (
    <>
      {head}
      <div className="set-row">
        <div className="set-lab">
          <b>Let Assist set up Discord</b>
          <small>
            {setUp
              ? 'Already set up. Run it again to fix a problem, change the bot or add a server: Assist skips the steps that are done.'
              : 'Assist opens the Discord website in its Workbench browser and does each step it can. You sign in, type your password and pass the "I am human" checks. Already have a bot? Assist can use it too.'}
          </small>
        </div>
        <button className="btn-primary" onClick={() => void setUpWithAssist()}>
          {SET_UP_WITH_ASSIST}
        </button>
      </div>
      {assistError && <div className="acct-login-state bad">{assistError}</div>}

      {setUp && (
        <>
          <div className="set-grp">Bot</div>
          <div className="set-row">
            <div className="set-lab">
              <b>Your Discord account</b>
              <small>Only messages from this user reach Assist.</small>
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
                  ? MESSAGE_CONTENT_BY_HAND
                  : 'The bot reads only the bound channels. Koloft keeps the bot’s Message Content on, so it can read what you type.'}
              </small>
            </div>
            <div className={'acct-login-state' + statusClass(status)}>{statusText(status)}</div>
          </div>
          <div className="set-row">
            <div className="set-lab">
              <b>Server</b>
              <small>
                {status.phase !== 'connected'
                  ? 'Known once the bot is connected.'
                  : status.guilds.length
                    ? `The bot is in ${status.guilds.map((g) => g.name).join(', ')}.`
                    : `The bot is not in a server you own yet. ${SET_UP_WITH_ASSIST} invites it.`}
              </small>
            </div>
          </div>

          <div className="set-grp">Bindings</div>
          <div className="acct-section">
            <div className="acct-list">
              {discord.bindings.map((b) => (
                <div className="acct-row" key={b.id}>
                  <div className="acct-main">
                    <span className="acct-name">{scopeName(b.scope)}</span>
                    <span className="acct-note">{channelLabel(b)}</span>
                    <button
                      className="acct-x"
                      title="Unbind"
                      onClick={() => void window.api.conductors.unbind(b.id)}
                    >
                      Unbind
                    </button>
                  </div>
                  {status.failing[b.channel.channelId] && (
                    <div className="acct-login-state bad">
                      Cannot post here: {status.failing[b.channel.channelId]}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="acct-foot">
              <button className="mini" onClick={() => setBindConductor({})}>
                <IconPlus size={14} /> Bind a channel…
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
