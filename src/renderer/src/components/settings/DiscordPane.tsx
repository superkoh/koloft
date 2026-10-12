import { useState, type JSX } from 'react'
import { LuArrowUpRight, LuPlus } from 'react-icons/lu'
import { channelLabel, inviteLink, scopeName } from '@shared/conductors'
import { ageLabel } from '@shared/freshnessOps'
import { useStore } from '../../store'
import { setUpDiscordWithAssist } from '../ConductorsIsland'
import {
  DEVELOPER_PORTAL,
  MESSAGE_CONTENT_BY_HAND,
  ownerFromApp,
  statusClass,
  statusText,
  useDiscordStatus
} from '../../discordStatus'

const TOKEN_MASK = '••••••••••••••••'

export function DiscordPane(): JSX.Element {
  const discord = useStore((s) => s.settings.discord)
  const setBindConductor = useStore((s) => s.setBindConductor)
  const loaded = useDiscordStatus()
  const [token, setToken] = useState<string | null>(null)
  const [assistError, setAssistError] = useState('')

  const saveToken = async (): Promise<void> => {
    if (!token?.trim()) return
    if (await window.api.discord.setToken(token)) setToken(null)
  }

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
  const fromApp = ownerFromApp(status, discord)
  const appId = status.applicationId
  const candidate = status.candidate
  const editingToken = token !== null || status.phase === 'off'

  return (
    <>
      {head}
      <div className="set-row">
        <div className="set-lab">
          <b>Let Assist set up Discord</b>
          <small>
            Assist opens the Discord website in its Workbench browser and does each step it can. You
            sign in, type your password and pass the &quot;I am human&quot; checks.
          </small>
        </div>
        <button className="btn-primary" onClick={() => void setUpWithAssist()}>
          Set up with Assist
        </button>
      </div>
      {assistError && <div className="acct-login-state bad">{assistError}</div>}

      <div className="set-grp">Bot</div>
      <div className="set-row">
        <div className="set-lab">
          <b>Bot token</b>
          <small>Stored in the macOS Keychain</small>
        </div>
        {editingToken ? (
          <>
            <div className="cb-input">
              <input
                className="cb-field"
                type="password"
                spellCheck={false}
                autoComplete="off"
                placeholder="Bot token"
                aria-label="Bot token"
                value={token ?? ''}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveToken()
                }}
              />
            </div>
            <button className="mini" onClick={() => void saveToken()}>
              Save
            </button>
          </>
        ) : (
          <>
            <span className="acct-note">{TOKEN_MASK}</span>
            <button className="mini" onClick={() => setToken('')}>
              Change
            </button>
          </>
        )}
      </div>
      <div className="set-row">
        <div className="set-lab">
          <b>Your Discord account</b>
          <small>Only messages from this user reach Assist.</small>
        </div>
        <span className="acct-note">
          {discord.userId
            ? `You are ${discord.userName ?? discord.userId}${fromApp ? ' · owner of the bot’s app' : ''}`
            : status.phase === 'connected'
              ? 'Send any message in your server'
              : 'Not set'}
        </span>
        {discord.userId && !fromApp && (
          <button className="mini" onClick={() => void window.api.discord.forgetOwner()}>
            Change
          </button>
        )}
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
                <button className="btn-primary" onClick={() => void window.api.discord.pair(true)}>
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
        {status.phase === 'intents' && (
          <button
            className="mini"
            onClick={() => window.api.browser.openExternal(DEVELOPER_PORTAL)}
          >
            Open Developer Portal <LuArrowUpRight size={13} />
          </button>
        )}
      </div>
      <div className="set-row">
        <div className="set-lab">
          <b>Server</b>
          <small>
            {status.guilds.length
              ? `The bot is in ${status.guilds.map((g) => g.name).join(', ')}.`
              : 'Invite the bot to a server you own.'}
          </small>
        </div>
        <button
          className="mini"
          disabled={!appId}
          onClick={() => appId && window.api.browser.openExternal(inviteLink(appId))}
        >
          Invite the bot <LuArrowUpRight size={13} />
        </button>
      </div>

      {status.phase !== 'off' && (
        <>
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
                <LuPlus size={14} /> Bind a channel…
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
