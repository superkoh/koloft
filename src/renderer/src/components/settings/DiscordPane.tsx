import { useState, type JSX } from 'react'
import { LuChevronRight, LuPlus } from 'react-icons/lu'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { channelLabel, scopeName } from '@shared/conductors'
import { useStore } from '../../store'
import { SessionBackendIcon } from '../SessionBackendIcon'
import {
  nextSetupStep,
  nextStepLine,
  SETUP_STEPS,
  statusClass,
  statusText,
  useDiscordStatus
} from '../../discordStatus'

const TOKEN_MASK = '••••••••••••••••'

export function DiscordPane(): JSX.Element {
  const discord = useStore((s) => s.settings.discord)
  const setBindConductor = useStore((s) => s.setBindConductor)
  const setDiscordSetupStep = useStore((s) => s.setDiscordSetupStep)
  const loaded = useDiscordStatus()
  const [token, setToken] = useState<string | null>(null)

  const saveToken = async (): Promise<void> => {
    if (!token?.trim()) return
    await window.api.discord.setToken(token)
    setToken(null)
  }

  const head = (
    <div className="set-ph">
      <h3>Discord</h3>
      <p>
        Talk to your conductors from Discord. Each conductor is a normal session bound to one
        channel.
      </p>
    </div>
  )
  if (!loaded) return head
  const status = loaded
  const hasToken = status.phase !== 'off'
  const next = nextSetupStep(status, discord)
  const statusLabel = (
    <div className="set-lab">
      <b>Status</b>
      <small>The bot reads only the bound channels.</small>
    </div>
  )
  const accountLabel = (
    <div className="set-lab">
      <b>Your Discord account</b>
      <small>Only messages from this user reach a conductor.</small>
    </div>
  )
  const tokenLabel = (
    <div className="set-lab">
      <b>Bot token</b>
      <small>Stored in the macOS Keychain</small>
    </div>
  )

  if (next !== null)
    return (
      <>
        {head}
        <div className="set-row">
          <div className="set-lab">
            <b>Discord is not set up yet.</b>
            <small>{nextStepLine(next)}</small>
          </div>
          <button className="btn-primary" onClick={() => setDiscordSetupStep(next)}>
            Set up Discord…
          </button>
        </div>
        <div className="set-grp">Bot</div>
        <div className="set-row off">
          {tokenLabel}
          <span className="acct-note">{hasToken ? TOKEN_MASK : 'Not set'}</span>
        </div>
        <div className="set-row off">
          {accountLabel}
          <span className="acct-note">
            {discord.userId ? `You are ${discord.userName ?? discord.userId}` : 'Not set'}
          </span>
        </div>
        <div className="set-row off">
          {statusLabel}
          <div className={'acct-login-state' + statusClass(status)}>{statusText(status)}</div>
        </div>
      </>
    )

  return (
    <>
      {head}
      <div className="set-row">
        <div className="set-lab">
          <button
            className="ob-link"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            onClick={() => setDiscordSetupStep(1)}
          >
            <LuChevronRight size={14} />
            Setup guide
          </button>
        </div>
        <div className="acct-login-state ok">✓ All {SETUP_STEPS} steps done</div>
      </div>

      <div className="set-grp">Bot</div>
      <div className="set-row">
        {tokenLabel}
        {token === null ? (
          <>
            <span className="acct-note">{TOKEN_MASK}</span>
            <button className="mini" onClick={() => setToken('')}>
              Change
            </button>
          </>
        ) : (
          <>
            <div className="cb-input">
              <input
                className="cb-field"
                type="password"
                autoFocus
                spellCheck={false}
                autoComplete="off"
                aria-label="Bot token"
                value={token}
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
        )}
      </div>
      <div className="set-row">
        {accountLabel}
        <span className="acct-note">You are {discord.userName ?? discord.userId}</span>
        <button
          className="mini"
          onClick={() => {
            void window.api.discord.forgetOwner()
            setDiscordSetupStep(6)
          }}
        >
          Change
        </button>
      </div>
      <div className="set-row">
        {statusLabel}
        <div className={'acct-login-state' + statusClass(status)}>{statusText(status)}</div>
      </div>

      <div className="set-grp">Bindings</div>
      <div className="acct-section">
        <div className="acct-list">
          {discord.bindings.map((b) => (
            <div className="acct-row" key={b.id}>
              <div className="acct-main">
                <SessionBackendIcon backend={b.backend} size={14} />
                <span className="acct-name">{scopeName(b.scope)}</span>
                <span className="acct-note">
                  {BACKEND_LABEL[b.backend]} · {channelLabel(b)}
                </span>
                <button
                  className="acct-x"
                  title="Unbind"
                  onClick={() => void window.api.conductors.unbind(b.id)}
                >
                  Unbind
                </button>
              </div>
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
  )
}
