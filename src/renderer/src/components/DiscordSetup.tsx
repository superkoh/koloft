import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { LuArrowUpRight, LuPlus, LuX } from 'react-icons/lu'
import type { DiscordStatus } from '@shared/types'
import { ageLabel } from '@shared/freshnessOps'
import { useStore } from '../store'
import { SETUP_STEPS, useDiscordStatus } from '../discordStatus'

const DEVELOPER_PORTAL = 'https://discord.com/developers/applications'
const INVITE_PERMISSIONS = 101440

function inviteLink(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&permissions=${INVITE_PERMISSIONS}&scope=bot`
}

function bold(text: string): ReactNode[] {
  return text.split('**').map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))
}

function Steps({ items }: { items: string[] }): JSX.Element {
  return (
    <ol>
      {items.map((item) => (
        <li key={item}>{bold(item)}</li>
      ))}
    </ol>
  )
}

const WIZARD_FOOT = 'One bot serves all your conductors: the global one and one per workspace.'

interface Page {
  name: string
  why: string
  list: ReactNode
  warn?: string
}

const PAGES: Page[] = [
  {
    name: 'Create the app — on the Discord website',
    why: 'Koloft talks to Discord through a bot you own. A bot lives inside an "app" you make on the Discord Developer Portal. This is the only part that must be done on the website (a phone browser works too); everything else happens in the Discord app.',
    list: (
      <Steps
        items={[
          'Click **Open Developer Portal** below. It opens in your normal browser.',
          'Log in with your Discord account.',
          'If a "Why are you visiting the Developer Portal?" question shows up, click **Skip (跳过)**.',
          'Click **New Application (新 APP)** at the top right.',
          "Name it **Koloft** (any name works), tick the box that agrees to Discord's terms, click **Create (创建)**."
        ]}
      />
    ),
    warn: 'If something goes wrong: "Missing Access (缺少权限)" when you click Create → you are in Koloft\'s built-in browser; open the portal in Safari or Chrome instead.'
  },
  {
    name: 'Make the bot private and let it read messages',
    why: 'A private bot can only be added by you, and the bot needs "Message Content" to read what you type.',
    list: (
      <Steps
        items={[
          'In your app, open **Installation (安装)** in the left menu.',
          'Under **Install Link (安装链接)**, change the dropdown to **None (无)**, then click **Save Changes (保存更改)** at the bottom.',
          'Open **Bot (机器人)** in the left menu.',
          'Under **Authorization Flow (授权流程)**, turn **Public Bot (公开 APP)** off.',
          'Under **Privileged Gateway Intents**, turn **Message Content Intent (消息内容)** on.',
          'Click **Save Changes (保存更改)**.'
        ]}
      />
    ),
    warn: 'If something goes wrong: "Private application cannot have a default authorization link (私密 APP 无法拥有默认授权关联)" → do step 2 (Install Link → None) first, then turn Public Bot off.'
  },
  {
    name: 'Copy the bot token into Koloft',
    why: "The token is the bot's password. Koloft keeps it in the macOS Keychain and never shows it again. Never paste it anywhere else.",
    list: (
      <Steps
        items={[
          'Still on **Bot (机器人)**, click **Reset Token (重置令牌)** and confirm. Discord may ask for your password or a 2-factor code.',
          'Click **Copy (复制)** next to the token. Discord shows it only this once.',
          'Paste it below and click **Save**.'
        ]}
      />
    )
  },
  {
    name: 'Make a private server — in the Discord app',
    why: 'Your conductors talk to you in channels of a server only you are in.',
    list: (
      <>
        <h4>On iPhone:</h4>
        <Steps
          items={[
            'Open Discord. In the far-left column of server icons, scroll to the bottom and tap **＋ (Add a Server)**.',
            'Tap **Create My Own**, then **For me and my friends**.',
            'Name it (for example **koloft**) and tap **Create Server**.'
          ]}
        />
        <p>{bold('On a computer: same steps — click **＋** at the bottom of the server list.')}</p>
        <p>Already have a server only you are in? Skip this step.</p>
      </>
    )
  },
  {
    name: 'Add the bot to your server',
    why: 'The bot can only see servers it has been added to. Once added, it sees every normal channel in that server, including ones you make later.',
    list: (
      <Steps
        items={[
          'Click **Invite the bot** below. It opens Discord\'s "add an app" page with the right permissions already chosen (see channels, send messages, attach files, read message history, add reactions).',
          'Pick your server from **Add to server (添加到服务器)**, click **Continue (继续)**, then **Authorize (授权)**, and pass the "I am human" check.',
          "In your server's member list you now see **Koloft** with a BOT tag. It shows online while Koloft runs on your Mac."
        ]}
      />
    )
  },
  {
    name: 'Tell Koloft who you are',
    why: 'Only your messages reach a conductor; anyone else in the channel is ignored.',
    list: (
      <Steps
        items={[
          'In any channel of your server, send any message — for example **hi**.',
          "It shows up here within a few seconds, with the sender's name and picture.",
          'If it is you, click **This is me**. Koloft remembers your Discord account from now on.'
        ]}
      />
    )
  },
  {
    name: 'Make a channel and bind a conductor',
    why: 'Each conductor talks to you in its own channel — one for the global conductor, one per workspace you bind.',
    list: (
      <Steps
        items={[
          'In your server, tap **＋** next to "Text Channels", name the channel (for example **koloft-all**), keep it a normal (not private) channel, create it.',
          "Click **Bind a channel…** below, pick Global or a workspace, Claude or Codex, then pick the channel from the list (Koloft reads your server's channels through the bot — no link to copy), click **Bind**.",
          'Say hello in that channel. The conductor answers there.'
        ]}
      />
    )
  }
]

function Done({ children }: { children: ReactNode }): JSX.Element {
  return <div className="acct-login-state ok">{children}</div>
}

function Hint({ children }: { children: ReactNode }): JSX.Element {
  return <div className="field-hint">{children}</div>
}

function TokenStep({ status }: { status: DiscordStatus }): JSX.Element {
  const [token, setToken] = useState('')
  const save = async (): Promise<void> => {
    if (!token.trim()) return
    if (await window.api.discord.setToken(token)) setToken('')
  }
  return (
    <>
      <div className="cb-input focus">
        <input
          className="cb-field"
          type="password"
          spellCheck={false}
          autoComplete="off"
          placeholder="Bot token"
          aria-label="Bot token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
      </div>
      <button className="mini" onClick={() => void save()}>
        Save
      </button>
      {status.phase === 'connected' ? (
        <Done>✓ Connected as {status.botName}</Done>
      ) : status.phase === 'token' ? (
        <div className="acct-login-state bad">
          Invalid token — reset it again and paste the new one.
        </div>
      ) : status.phase === 'connecting' ? (
        <Hint>Connecting…</Hint>
      ) : (
        <Hint>
          After saving, Koloft connects and shows &quot;Connected as Koloft&quot; here.
          &quot;Invalid token&quot; → reset it again and paste the new one.
        </Hint>
      )}
    </>
  )
}

function PairStep({ status }: { status: DiscordStatus }): JSX.Element {
  const discord = useStore((s) => s.settings.discord)
  if (discord.userId)
    return (
      <Done>
        ✓ You are {discord.userName ?? discord.userId}{' '}
        <button className="ob-link" onClick={() => void window.api.discord.forgetOwner()}>
          Change
        </button>
      </Done>
    )
  const c = status.candidate
  if (!c) return <div className="acct-empty">Waiting for a message in your server…</div>
  return (
    <div className="acct-list">
      <div className="acct-row">
        <div className="acct-main">
          <span
            style={{
              flex: 'none',
              width: 24,
              height: 24,
              borderRadius: '50%',
              background: 'var(--bg-3)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 650,
              color: 'var(--fg-dim)'
            }}
          >
            {c.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="acct-name">{c.name}</span>
          <span className="acct-note">
            “{c.text}” · {ageLabel(c.at, Date.now())}
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
  )
}

function StepAction({ step, status }: { step: number; status: DiscordStatus }): JSX.Element | null {
  const setDiscordSetupStep = useStore((s) => s.setDiscordSetupStep)
  const setBindConductor = useStore((s) => s.setBindConductor)
  switch (step) {
    case 1:
      return (
        <button className="mini" onClick={() => window.api.browser.openExternal(DEVELOPER_PORTAL)}>
          Open Developer Portal <LuArrowUpRight size={13} />
        </button>
      )
    case 2:
      if (status.phase === 'connected') return <Done>✓ Message Content is on</Done>
      if (status.phase === 'intents')
        return (
          <div className="acct-login-state bad">
            Message Content is off. Turn it on (steps 5 and 6 above); Koloft checks again every 30
            seconds.
          </div>
        )
      return (
        <Hint>
          Koloft checks Message Content when it connects and tells you here if it is still off.
        </Hint>
      )
    case 3:
      return <TokenStep status={status} />
    case 5:
      return (
        <>
          <button
            className="mini"
            title="needs the token from step 3"
            disabled={!status.applicationId}
            onClick={() =>
              status.applicationId &&
              window.api.browser.openExternal(inviteLink(status.applicationId))
            }
          >
            Invite the bot <LuArrowUpRight size={13} />
          </button>
          {status.guildNames.length > 0 ? (
            <Done>✓ The bot is in your server {status.guildNames[0]}</Done>
          ) : (
            <Hint>Koloft shows ✓ here once it sees the bot in a server.</Hint>
          )}
        </>
      )
    case 6:
      return <PairStep status={status} />
    case 7:
      return (
        <button
          className="mini"
          onClick={() => {
            setDiscordSetupStep(null)
            setBindConductor({})
          }}
        >
          <LuPlus size={14} /> Bind a channel…
        </button>
      )
    default:
      return null
  }
}

export function DiscordSetup(): JSX.Element | null {
  const step = useStore((s) => s.discordSetupStep)
  const setStep = useStore((s) => s.setDiscordSetupStep)
  const paired = useStore((s) => !!s.settings.discord.userId)
  const status = useDiscordStatus()

  useEffect(() => {
    if (step === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setStep(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [step, setStep])

  if (step === null) return null
  const page = PAGES[step - 1]
  const close = (): void => setStep(null)
  const last = step === SETUP_STEPS

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal worktreesess"
        role="dialog"
        aria-label="Set up Discord"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>Set up Discord</span>
          <span className="modal-close" onClick={close} aria-label="Close">
            <LuX size={16} />
          </span>
        </div>
        <div className="modal-body">
          <div className="field">
            <span className="flabel">
              Step {step} of {SETUP_STEPS}
            </span>
            <span className="field-label">{page.name}</span>
            <div className="field-hint">{page.why}</div>
          </div>
          <div className="update-notes">{page.list}</div>
          <StepAction step={step} status={status} />
          {page.warn && <div className="field-hint warn">{page.warn}</div>}
          <div className="field-hint">{WIZARD_FOOT}</div>
        </div>
        <div className="modal-foot ob-actions">
          <span className="ob-skip" />
          <div className="ob-dots">
            {PAGES.map((_, i) => (
              <i key={i} className={'ob-dot' + (i + 1 === step ? ' on' : '')} />
            ))}
          </div>
          <div className="ob-go">
            {step > 1 && (
              <button className="mini ob-back" onClick={() => setStep(step - 1)}>
                Back
              </button>
            )}
            <button
              className="btn-primary"
              disabled={step === 6 && !paired}
              onClick={() => (last ? close() : setStep(step + 1))}
            >
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
