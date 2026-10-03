import { useEffect, useState, type JSX } from 'react'
import { LuPlus } from 'react-icons/lu'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { channelLabel, scopeName } from '@shared/conductors'
import { useStore } from '../../store'
import { SessionBackendIcon } from '../SessionBackendIcon'

const TOKEN_MASK = '••••••••••••••••'

export function DiscordPane(): JSX.Element {
  const discord = useStore((s) => s.settings.discord)
  const setBindConductor = useStore((s) => s.setBindConductor)
  const [hasToken, setHasToken] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [userId, setUserId] = useState(discord.userId ?? '')

  useEffect(() => {
    void window.api.discord.hasToken().then(setHasToken)
  }, [])

  const saveToken = async (): Promise<void> => {
    if (!token?.trim()) return
    if (await window.api.discord.setToken(token)) setHasToken(true)
    setToken(null)
  }

  return (
    <>
      <div className="set-ph">
        <h3>Discord</h3>
        <p>
          Talk to your conductors from Discord. Each conductor is a normal session bound to one
          channel.
        </p>
      </div>

      <div className="set-grp">Bot</div>
      <div className="set-row">
        <div className="set-lab">
          <b>Bot token</b>
          <small>Stored in the macOS Keychain</small>
        </div>
        {token === null ? (
          <>
            <span className="acct-note">{hasToken ? TOKEN_MASK : 'Not set'}</span>
            <button className="mini" onClick={() => setToken('')}>
              {hasToken ? 'Change' : 'Set'}
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
        <div className="set-lab">
          <b>Your Discord user ID</b>
          <small>Only messages from this user reach a conductor.</small>
        </div>
        <div className="cb-input">
          <input
            className="cb-field"
            spellCheck={false}
            autoComplete="off"
            aria-label="Your Discord user ID"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            onBlur={() => void window.api.discord.setUserId(userId)}
          />
        </div>
      </div>
      <div className="set-row">
        <div className="set-lab">
          <b>Status</b>
          <small>The bot reads only the bound channels.</small>
        </div>
        <div className="acct-login-state">Not connected</div>
      </div>

      <div className="set-grp">Bindings</div>
      <div className="acct-section">
        {discord.bindings.length === 0 ? (
          <div className="acct-empty">No channels bound yet.</div>
        ) : (
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
        )}
        <div className="acct-foot">
          <button className="mini" onClick={() => setBindConductor({})}>
            <LuPlus size={14} /> Bind a channel…
          </button>
        </div>
      </div>
    </>
  )
}
