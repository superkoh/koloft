import { useCallback, useEffect, useState, type JSX } from 'react'
import type { DiscoveredFolder } from '@shared/types'
import { basename } from '@shared/preview'
import { shortenHome } from '../browseModel'
import { useStore } from '../store'
import { relTime } from '../sessionRows'
import { useSettingsUpdate } from './settings/useSettingsUpdate'

const PIC_ROWS: { color: string; title: string; state: string; cold?: boolean }[] = [
  { color: 'var(--accent)', title: 'Fix login bug', state: 'working' },
  { color: 'var(--amber)', title: 'Write tests', state: 'needs your OK' },
  { color: 'var(--fg-faint)', title: 'Refactor api', state: 'yesterday', cold: true }
]

const PIC_FILES: [string, string, string][] = [
  ['app.tsx', '+12', '−3'],
  ['api.ts', '+4', '−1'],
  ['test.ts', '+7', '']
]

function PicFlow(): JSX.Element {
  return (
    <svg className="pic" viewBox="0 0 520 148" role="img" aria-label="folder, sessions, Workbench">
      <g fill="none" stroke="var(--line)">
        <rect x="6.5" y="22.5" width="104" height="88" rx="8" fill="var(--bg-1)" />
        <rect x="152.5" y="22.5" width="176" height="88" rx="8" fill="var(--bg-1)" />
        <rect x="370.5" y="22.5" width="144" height="88" rx="8" fill="var(--bg-1)" />
      </g>
      <g stroke="var(--fg-faint)" strokeWidth="1.2" fill="none">
        <path d="M116 66 h28" />
        <path d="M138 61 l6 5 -6 5" />
        <path d="M334 66 h28" />
        <path d="M356 61 l6 5 -6 5" />
      </g>
      <path
        d="M32 58 h14 l4 5 h18 a3 3 0 0 1 3 3 v14 a3 3 0 0 1 -3 3 H32 a3 3 0 0 1 -3 -3 V61 a3 3 0 0 1 3 -3 z"
        fill="var(--folder)"
        opacity="0.85"
      />
      <text x="58" y="97" className="pt-mono" textAnchor="middle" fill="var(--fg-dim)">
        my-app/
      </text>

      {PIC_ROWS.map((r, i) => {
        const y = 32 + i * 26
        return (
          <g key={r.title}>
            <rect
              x="162"
              y={y}
              width="3"
              height="18"
              rx="1.5"
              fill={r.color}
              opacity={r.cold ? 0.45 : undefined}
            />
            <text
              x="172"
              y={y + 9}
              className="pt"
              fill={r.cold ? 'var(--fg-cold)' : 'var(--fg)'}
              fontStyle={r.cold ? 'italic' : undefined}
            >
              {r.title}
            </text>
            <text x="172" y={y + 18} className="pt-sm" fill="var(--fg-faint)">
              {r.state}
            </text>
          </g>
        )
      })}

      <text x="382" y="41" className="pt-sm" fill="var(--accent)">
        Files
      </text>
      <text x="410" y="41" className="pt-sm" fill="var(--fg-faint)">
        Web
      </text>
      <text x="436" y="41" className="pt-sm" fill="var(--fg-faint)">
        Shell
      </text>
      <path d="M378 47 h128" stroke="var(--line)" />
      {PIC_FILES.map(([name, added, removed], i) => {
        const y = 63 + i * 17
        return (
          <g key={name}>
            <text x="382" y={y} className="pt-mono" fill="var(--fg-dim)">
              {name}
            </text>
            <text x="466" y={y} className="pt-mono" fill="var(--good)">
              {added}
            </text>
            <text x="492" y={y} className="pt-mono" fill="var(--red)">
              {removed}
            </text>
          </g>
        )
      })}

      <g className="pt-sm" fill="var(--fg-faint)" textAnchor="middle">
        <text x="58" y="126">
          workspace
        </text>
        <text x="240" y="126">
          sessions
        </text>
        <text x="442" y="126">
          Workbench
        </text>
      </g>
    </svg>
  )
}

const METERS: { name: string; pct: number; color: string }[] = [
  { name: 'A', pct: 83, color: 'var(--red)' },
  { name: 'B', pct: 22, color: 'var(--good)' },
  { name: 'C', pct: 53, color: 'var(--amber)' }
]

function PicAccounts(): JSX.Element {
  return (
    <svg className="pic" viewBox="0 0 380 96" role="img" aria-label="a new session picks account B">
      <rect
        x="2.5"
        y="38.5"
        width="94"
        height="24"
        rx="12"
        fill="var(--accent-soft)"
        stroke="var(--accent)"
      />
      <text x="49" y="54" className="pt" textAnchor="middle" fill="var(--fg)">
        ＋ New session
      </text>
      <text x="113" y="42" className="pt-sm" textAnchor="middle" fill="var(--accent)">
        picks B
      </text>
      <g stroke="var(--accent)" strokeWidth="1.2" fill="none">
        <path d="M100 50 h26" />
        <path d="M120 45 l6 5 -6 5" />
      </g>
      {METERS.map((m, i) => {
        const y = 16 + i * 30
        return (
          <g key={m.name}>
            <text x="136" y={y + 8} className="pt" textAnchor="middle" fill="var(--fg-dim)">
              {m.name}
            </text>
            <rect x="146" y={y} width="170" height="8" rx="4" fill="var(--bg-3)" />
            <rect x="146" y={y} width={(170 * m.pct) / 100} height="8" rx="4" fill={m.color} />
            <text x="324" y={y + 8} className="pt-sm" fill="var(--fg-faint)">
              {m.pct}%
            </text>
          </g>
        )
      })}
    </svg>
  )
}

const LEGEND: { cls: string; name: string; what: string }[] = [
  { cls: 'st-working', name: 'Orange', what: 'working' },
  { cls: 'st-approval', name: 'Amber', what: 'needs your OK' },
  { cls: 'st-waiting', name: 'Green', what: 'turn done' },
  { cls: 'st-idle', name: 'Dim green', what: 'done a while ago, nothing new' }
]

type Probe = 'pending' | 'found' | 'missing'

export function Onboarding({
  onAddWorkspace,
  onStartIn
}: {
  onAddWorkspace: () => Promise<boolean>
  onStartIn: (wsPath: string) => void
}): JSX.Element {
  const update = useSettingsUpdate()
  const firstWs = useStore((s) => s.workspaceRows[0]?.workspace.path)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  const [step, setStep] = useState(1)
  const [found, setFound] = useState<DiscoveredFolder[] | null>(null)
  const [checked, setChecked] = useState<string[]>([])
  const [balance, setBalance] = useState(false)
  const [probe, setProbe] = useState<Probe>('pending')
  const [codexFound, setCodexFound] = useState(false)

  useEffect(() => {
    if (step !== 2 || found !== null) return
    void window.api.workspace.discover().then((d) => {
      setFound(d)
      setChecked(d.map((f) => f.path))
    })
  }, [step, found])

  const runProbe = useCallback((): void => {
    setProbe('pending')
    setCodexFound(false)
    void Promise.all([window.api.claude.probe(), window.api.sessions.backends()]).then(
      ([claude, backends]) => {
        setCodexFound(backends.some((b) => b.id === 'codex' && b.available))
        setProbe(claude.found ? 'found' : 'missing')
      }
    )
  }, [])

  const finish = useCallback((): void => {
    update({ onboardingSeen: true })
    if (balance) setSettingsOpen(true)
  }, [update, setSettingsOpen, balance])

  const now = Date.now()
  const primary = ((): { label: string; disabled?: boolean; go?: () => void } => {
    if (step === 1) return { label: 'Next', go: () => setStep(2) }
    if (step === 2) {
      if (found === null) return { label: 'Next', disabled: true }
      if (found.length === 0)
        return {
          label: 'Choose Folder…',
          go: () => void onAddWorkspace().then((ok) => ok && setStep(3))
        }
      if (checked.length === 0) return { label: 'Skip for now', go: () => setStep(3) }
      return {
        label: checked.length === 1 ? 'Pin 1 workspace' : `Pin ${checked.length} workspaces`,
        go: () =>
          void (async () => {
            for (const p of checked) await window.api.workspace.add(p)
            setStep(3)
          })()
      }
    }
    if (step === 3)
      return {
        label: 'Continue',
        go: () => {
          setStep(4)
          runProbe()
        }
      }
    if (probe === 'pending') return { label: '＋ Start first session', disabled: true }
    if (probe === 'missing' && (balance || !codexFound))
      return { label: 'Check again', go: runProbe }
    if (balance) return { label: 'Set up accounts', go: finish }
    if (!firstWs) return { label: 'Choose Folder…', go: () => void onAddWorkspace() }
    return {
      label: '＋ Start first session',
      go: () => {
        finish()
        onStartIn(firstWs)
      }
    }
  })()

  return (
    <div className="w-empty onboarding" tabIndex={-1}>
      <div className="ob-step">
        <div className="eyebrow">Welcome · {step} of 4</div>

        {step === 1 && (
          <>
            <div className="big">Koloft runs Claude Code — and Codex, if you have it.</div>
            <div className="quiet">
              Pick a <b>folder</b>. Koloft shows every <b>session</b> in it. Each Claude session
              gets a side panel, the <b>Workbench</b>: the files Claude changed, a browser, a shell.
            </div>
            <PicFlow />
            <div className="quiet">
              Nothing is copied. Koloft reads Claude&apos;s own files, so sessions you started in a
              plain terminal show up here too.
            </div>
          </>
        )}

        {step === 2 && found !== null && found.length > 0 && (
          <>
            <div className="big">Pick your first workspace.</div>
            <div className="quiet">
              You have used Claude Code in these folders before. Pin the ones you want in the
              sidebar.
            </div>
            <div className="disc-list">
              {found.map((f) => (
                <label key={f.path} className="disc-row">
                  <input
                    type="checkbox"
                    checked={checked.includes(f.path)}
                    onChange={(e) =>
                      setChecked((c) =>
                        e.target.checked ? [...c, f.path] : c.filter((p) => p !== f.path)
                      )
                    }
                  />
                  <span className="disc-main">
                    <span className="disc-name">{basename(f.path)}</span>
                    <span className="disc-path">{shortenHome(f.path, window.api.home)}</span>
                  </span>
                  <span className="disc-meta">
                    {f.sessions} session{f.sessions === 1 ? '' : 's'} · {relTime(f.mtime, now)}
                  </span>
                </label>
              ))}
            </div>
            <div className="quiet">
              Or{' '}
              <button className="ob-link" onClick={() => void onAddWorkspace()}>
                choose another folder
              </button>{' '}
              <span className="quiet key">⇧⌘O</span>. Any folder works; a git checkout gets extra
              help.
            </div>
          </>
        )}

        {step === 2 && found !== null && found.length === 0 && (
          <>
            <div className="big">Pick a folder to work in.</div>
            <div className="quiet">
              Any folder works; a git checkout gets extra help. You can add more later with{' '}
              <span className="quiet key">⇧⌘O</span>.
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="big">Use your existing login.</div>
            <div className="quiet">
              {codexFound
                ? 'Claude Code needs a login, and Codex keeps its own. Koloft can also spread your Claude sessions over several accounts.'
                : 'Claude Code needs a login. Keep the one this Mac already has, or let Koloft spread your sessions over several accounts.'}
            </div>
            <div className="ob-choices">
              <button
                className={'choice' + (balance ? '' : ' on')}
                onClick={() => setBalance(false)}
              >
                <span className="choice-t">The login this Mac already has</span>
                <span className="choice-d">
                  Whatever <code>claude</code>{' '}
                  {codexFound && (
                    <>
                      or <code>codex</code>{' '}
                    </>
                  )}
                  is signed in as now. Nothing to do.
                </span>
              </button>
              <button
                className={'choice' + (balance ? ' on' : '')}
                onClick={() => setBalance(true)}
              >
                <span className="choice-t">Balance several Claude accounts</span>
                <span className="choice-d">
                  Each new session starts on the one with the most room left. Set it up in Settings
                  ▸ Accounts after this.
                </span>
              </button>
            </div>
            <PicAccounts />
          </>
        )}

        {step === 4 && (
          <>
            <div className="big">Know when a session needs you.</div>
            <div className="quiet">
              Every running session has a light on its left edge. You never have to watch a terminal
              to know what is going on.
            </div>
            <div className="ob-legend">
              {LEGEND.map((l) => (
                <div key={l.cls} className="ob-leg">
                  <i className={'ob-bar ' + l.cls} />
                  <b>{l.name}</b>
                  <span>— {l.what}</span>
                </div>
              ))}
            </div>
            <div className="quiet">
              When Koloft is in the background, a light turning amber or green also sends a
              notification (Settings ▸ Notifications).
            </div>
            {probe === 'missing' && (balance || !codexFound) ? (
              <div className="quiet ob-warn">
                {balance
                  ? 'Claude Code is required to balance accounts.'
                  : 'Install Claude Code or a supported Codex CLI to start a session.'}
                <code className="ob-cmd">npm install -g @anthropic-ai/claude-code</code>
                {!balance && <code className="ob-cmd">npm install -g @openai/codex</code>}
              </div>
            ) : balance ? (
              <div className="quiet">
                Add your accounts first. Then ＋ New session on the workspace starts the first one.
              </div>
            ) : (
              <div className="quiet">
                {codexFound ? 'The CLI' : 'Claude itself'} may ask a thing or two first: theme,
                login, whether you trust this folder. Answer in the terminal.
              </div>
            )}
          </>
        )}
      </div>

      <div className="ob-actions">
        <button className="ob-link ob-skip" onClick={finish}>
          {step === 4 ? 'Not now' : 'Skip'}
        </button>
        <div className="ob-dots">
          {[1, 2, 3, 4].map((n) => (
            <i key={n} className={'ob-dot' + (n === step ? ' on' : '')} />
          ))}
        </div>
        <div className="ob-go">
          {step > 1 && (
            <button className="mini ob-back" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button className="btn-primary" disabled={primary.disabled} onClick={primary.go}>
            {primary.label}
          </button>
        </div>
      </div>
    </div>
  )
}
