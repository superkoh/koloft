import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { BackendId, DiscoveredFolder, SessionRow } from '@shared/types'
import { SIGN_IN_FOLDER_OF } from '@shared/types'
import { BACKEND_LABEL, SESSION_BACKENDS, backendAvailable } from '@shared/sessionBackend'
import { accountToSignInAgain, hasUsableAccount } from '@shared/accountUsage'
import { basename } from '@shared/preview'
import { useStore } from '../store'
import { relTime } from '../sessionRows'
import { resumeSession } from '../resumeFlow'
import { useInstalledBackends } from '../useInstalledBackends'
import { useSettingsUpdate } from './settings/useSettingsUpdate'
import { SessionBackendIcon } from './SessionBackendIcon'
import { IconAiStart, IconAssist, IconCheck, IconFolderOpen, IconLoading, IconPlus } from '../icons'
import {
  defaultAccountName,
  defaultAgent,
  foldersToPin,
  lastUsedAgent,
  resumeTarget,
  rowsToAdopt,
  tallyAgents
} from '../welcomeModel'
import '../welcome.css'

type Step = 1 | 2 | 3 | 4
type Launch =
  { kind: 'resume'; row: SessionRow } | { kind: 'fresh'; backend: BackendId; prompt: string }

interface Folder {
  path: string
  rows: SessionRow[]
}

const MAKER: Record<BackendId, string> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  muse: 'Meta',
  agy: 'Google'
}

const AGENT_NAME: Record<BackendId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  muse: 'Muse',
  agy: 'Antigravity'
}

const SIGN_IN_HOW: Record<BackendId, string> = {
  claude: 'Your browser opens once. Koloft keeps the account: no terminal, nothing to paste.',
  codex:
    'A terminal tab opens and Codex sends you to your browser. It closes by itself once you are in.',
  muse: 'A terminal tab opens with a code to enter in your browser. It closes by itself once you are in.',
  agy: 'A terminal tab opens: sign in with Google, pick colours and accept Google’s terms, then type /exit.'
}

const SIDEBAR_ROWS_PER_FOLDER = 4
const AUTO_NEXT_MS = 900
const LEAVE_MS = 650
const SCAN_WAIT_MS = 6000
const SCAN_POLL_MS = 120

async function scanned(paths: string[]): Promise<void> {
  const deadline = Date.now() + SCAN_WAIT_MS
  const done = (): boolean => {
    const rows = useStore.getState().workspaceRows
    return paths.every((p) => rows.some((w) => w.workspace.path === p && w.workspace.hasHistory))
  }
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, SCAN_POLL_MS))
}

const backendOf = (l: Launch): BackendId => (l.kind === 'resume' ? l.row.backendId : l.backend)
const nextAgent = (b: BackendId): BackendId =>
  SESSION_BACKENDS[(SESSION_BACKENDS.indexOf(b) + 1) % SESSION_BACKENDS.length]
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function Title({ plain, script }: { plain: string; script: string }): JSX.Element {
  return (
    <h1 className="wl-title">
      {plain} <span className="wl-script">{script}</span>
    </h1>
  )
}

function Chip({ children, busy }: { children: ReactNode; busy?: boolean }): JSX.Element {
  return (
    <div className={'wl-chip' + (busy ? ' busy' : '')}>
      <span className="wl-dot" />
      {children}
    </div>
  )
}

function MiniSidebar({ folders }: { folders: Folder[] }): JSX.Element {
  const now = Date.now()
  return (
    <div className="wl-side">
      {folders.map((ws, wi) => (
        <div key={ws.path} className="wl-ws" style={{ animationDelay: `${wi * 180}ms` }}>
          <div className="wl-ws-head">
            <IconFolderOpen size={14} />
            <span>{basename(ws.path)}</span>
          </div>
          {[...ws.rows]
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, SIDEBAR_ROWS_PER_FOLDER)
            .map((r, ri) => (
              <div
                key={r.id}
                className={'wl-row' + (r.running ? ' live' : '')}
                style={{ animationDelay: `${wi * 180 + (ri + 1) * 140}ms` }}
              >
                <span className="wl-row-t">{r.title}</span>
                <span className="wl-row-s">
                  <SessionBackendIcon backend={r.backendId} size={10} decorative />
                  {BACKEND_LABEL[r.backendId]} · {relTime(r.mtime, now)}
                </span>
              </div>
            ))}
        </div>
      ))}
    </div>
  )
}

function LightKey(): JSX.Element {
  return (
    <div className="wl-key">
      <div className="wl-key-row grey">
        <i />
        <div>
          <b>Grey: started in your terminal</b>
          <small>Click one to pick it up here.</small>
        </div>
      </div>
      <div className="wl-key-cap">Once one runs here, its light turns:</div>
      <div className="wl-key-row working">
        <i />
        <div>
          <b>Orange: working</b>
          <small>Leave it be.</small>
        </div>
      </div>
      <div className="wl-key-row amber">
        <i />
        <div>
          <b>Amber: needs your OK</b>
          <small>Your turn to say yes or no.</small>
        </div>
      </div>
      <div className="wl-key-row green">
        <i />
        <div>
          <b>Green: done this round</b>
          <small>Come and look.</small>
        </div>
      </div>
    </div>
  )
}

export function Welcome({
  onAddFolder,
  onAddRemote,
  onStart
}: {
  onAddFolder: () => Promise<boolean>
  onAddRemote: () => void
  onStart: (wsPath: string, backend: BackendId, firstPrompt?: string) => void
}): JSX.Element {
  const update = useSettingsUpdate()
  const { installed } = useInstalledBackends()
  const accounts = useStore((s) => s.accounts)
  const workspaceRows = useStore((s) => s.workspaceRows)
  const login = useStore((s) => s.accountLogin)
  const beginLogin = useStore((s) => s.beginLogin)
  const setLoginProgress = useStore((s) => s.setLoginProgress)
  const addTab = useStore((s) => s.addTab)
  const showSignInTab = useStore((s) => s.showSignInTab)
  const signInTabId = useStore((s) => s.signIn?.tabId)
  const activeTabId = useStore((s) => s.activeTabId)

  const [step, setStep] = useState<Step>(1)
  const [found, setFound] = useState<DiscoveredFolder[] | null>(null)
  const [pinning, setPinning] = useState(false)
  const [agent, setAgent] = useState<BackendId | null>(null)
  const [signError, setSignError] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [peek, setPeek] = useState(false)
  const [pending, setPending] = useState<Launch | null>(null)
  const [chip, setChip] = useState<BackendId | null>(null)
  const [prompt, setPrompt] = useState('')
  const [leaving, setLeaving] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    void window.api.workspace.discover().then(setFound, () => setFound([]))
  }, [])

  const folders = useMemo<Folder[]>(
    () =>
      workspaceRows
        .filter((w) => !w.workspace.butler)
        .map((w) => ({ path: w.workspace.path, rows: w.rows })),
    [workspaceRows]
  )
  const allRows = folders.flatMap((f) => f.rows)
  const tally = useMemo(() => tallyAgents(found ?? []), [found])
  const emptyMac = found !== null && found.length === 0
  const lastUsed = installed && found ? lastUsedAgent(found, installed) : undefined
  const pick: BackendId = agent ?? (installed ? defaultAgent(found ?? [], installed) : 'claude')
  const isInstalled = (b: BackendId): boolean => !!installed && backendAvailable(installed, b)
  const signedIn = (b: BackendId): boolean => !!accounts && hasUsableAccount(accounts, b)
  const target = resumeTarget(allRows, Date.now())
  const targetFolder = target ? folders.find((f) => f.rows.includes(target)) : undefined
  const newAgent = chip ?? pick
  const signTabOpen = signingIn && pick !== 'claude' && !!signInTabId
  const again = accounts ? accountToSignInAgain(accounts, pick) : undefined
  const accountName = again ?? defaultAccountName(pick, accounts ?? [])

  useEffect(() => {
    if (step !== 2 || found === null || folders.length > 0 || pinning) return
    const pins = foldersToPin(found, Date.now())
    if (pins.length === 0) return
    setPinning(true)
    void (async () => {
      for (const f of pins) await window.api.workspace.add(f.path)
      await scanned(pins.map((f) => f.path))
      const now = Date.now()
      const lists = await Promise.all(pins.map((f) => window.api.workspace.historyRows(f.path)))
      await window.api.workspace.adopt(
        lists
          .flatMap((rows) => rowsToAdopt(rows, now))
          .map((r) => ({ id: r.id, backendId: r.backendId }))
      )
      setPinning(false)
    })()
  }, [step, found, folders.length, pinning])

  const finish = (): void => {
    if (leaving) return
    setLeaving(true)
    setTimeout(() => update({ onboardingSeen: true }), LEAVE_MS)
  }

  const run = (l: Launch): void => {
    if (started.current) return
    started.current = true
    if (l.kind === 'resume') {
      void resumeSession({
        id: l.row.id,
        backendId: l.row.backendId,
        title: l.row.title,
        restore: true
      })
    } else {
      const where = (targetFolder ?? folders[0])?.path
      if (where) onStart(where, l.backend, l.prompt || undefined)
    }
    finish()
  }
  const runRef = useRef(run)
  runRef.current = run

  const go4 = (): void => {
    const text = prompt.trim()
    const l: Launch =
      target && !text
        ? { kind: 'resume', row: target }
        : { kind: 'fresh', backend: newAgent, prompt: text }
    if (!signedIn(backendOf(l))) {
      setPending(l)
      setAgent(backendOf(l))
      setStep(3)
      return
    }
    run(l)
  }

  const ready = step === 3 && signedIn(pick)
  useEffect(() => {
    if (!ready || (!signingIn && !pending)) return
    const t = setTimeout(() => {
      setSigningIn(false)
      if (pending && backendOf(pending) === pick) runRef.current(pending)
      else setStep(4)
    }, AUTO_NEXT_MS)
    return () => clearTimeout(t)
  }, [ready, signingIn, pending, pick])

  const signIn = async (): Promise<void> => {
    setSignError(null)
    const name = accountName
    const failed =
      'Could not start the sign-in. Try again, or add the account in Settings ▸ Accounts.'
    if (pick === 'claude') {
      beginLogin(again)
      setLoginProgress({ phase: 'starting', name })
      setSigningIn(true)
      if ((await window.api.accounts.startLogin(name, !!again)) !== 'ok') {
        setSigningIn(false)
        setSignError(failed)
      }
      return
    }
    const r = await window.api.accounts.signIn(SIGN_IN_FOLDER_OF[pick], name, !!again)
    if (!r.ok) {
      setSignError(failed)
      return
    }
    setSigningIn(true)
    setPeek(false)
    showSignInTab(r.tabId)
    addTab({
      id: r.tabId,
      kind: 'shell',
      title: `${BACKEND_LABEL[pick]} sign in: ${name}`,
      cwd: r.cwd,
      alive: true
    })
  }

  const install = async (b: BackendId): Promise<void> => {
    const r = await window.api.sessions.installTool(b)
    if (!r) return
    setPeek(false)
    showSignInTab(r.tabId)
    addTab({
      id: r.tabId,
      kind: 'shell',
      title: `Install ${AGENT_NAME[b]}`,
      cwd: r.cwd,
      alive: true
    })
  }

  const loginPhase = pick === 'claude' ? login?.progress?.phase : undefined
  const claudeBusy = loginPhase === 'starting' || loginPhase === 'browser'

  const primary = ((): { label: string; go: () => void; busy?: boolean; disabled?: boolean } => {
    if (step === 1) return { label: 'Continue', go: () => setStep(2), disabled: installed === null }
    if (step === 2) {
      if (folders.length === 0 && emptyMac)
        return { label: 'Choose Folder…', go: () => void onAddFolder() }
      return { label: 'Continue', go: () => setStep(3), busy: pinning || found === null }
    }
    if (step === 3) {
      if (signedIn(pick))
        return {
          label: pending ? 'Start' : 'Continue',
          go: () => (pending ? run(pending) : setStep(4))
        }
      if (claudeBusy) return { label: 'Waiting for your browser…', go: () => undefined, busy: true }
      if (signTabOpen) return { label: 'Show the sign-in tab', go: () => setPeek(false) }
      return {
        label: isInstalled(pick)
          ? `Sign in to ${BACKEND_LABEL[pick]}`
          : `Install ${BACKEND_LABEL[pick]} and sign in`,
        go: () => void signIn()
      }
    }
    return { label: target ? `Resume “${target.title}”` : 'Start', go: go4 }
  })()
  const primaryRef = useRef(primary)
  primaryRef.current = primary
  const finishRef = useRef(finish)
  finishRef.current = finish

  const steppedAside = !!signInTabId && activeTabId === signInTabId && !peek

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (steppedAside || document.querySelector('.modal-backdrop')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        finishRef.current()
        return
      }
      if (e.key !== 'Enter' || e.isComposing) return
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT' && step !== 4) return
      e.preventDefault()
      const p = primaryRef.current
      if (!p.disabled && !p.busy) p.go()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [steppedAside, step])

  if (steppedAside) {
    return createPortal(
      <div className="wl-aside">
        <span className="wl-dot" />
        <span>Finish in the tab below. The welcome comes back when it closes.</span>
        <button className="ob-link" onClick={() => setPeek(true)}>
          Back to the welcome
        </button>
      </div>,
      document.body
    )
  }

  const readyCount = installed ? SESSION_BACKENDS.filter(isInstalled).length : 0
  const pickedFolder = emptyMac && folders.length > 0

  return createPortal(
    <div
      className={'wl' + (leaving ? ' leaving' : '')}
      data-step={step}
      role="dialog"
      aria-label="Welcome to Koloft"
    >
      <div className="wl-glow" aria-hidden="true">
        {SESSION_BACKENDS.map((b) => (
          <i key={b} className={'wl-blob ' + b + (isInstalled(b) ? ' on' : '')} />
        ))}
      </div>
      <header className="wl-top">
        <div className="wl-prog">
          {[1, 2, 3, 4].map((n) => (
            <i key={n} className={n === step ? 'on' : n < step ? 'past' : ''} />
          ))}
        </div>
        <button className="wl-skip" onClick={finish}>
          Skip setup <kbd>esc</kbd>
        </button>
      </header>

      <main className="wl-stage" key={step}>
        {step === 1 && (
          <>
            <Chip busy={installed === null}>
              {installed === null
                ? 'Looking around your Mac…'
                : `${readyCount} of 4 ready on this Mac`}
            </Chip>
            <Title plain="Four agents." script="One window." />
            <p className="wl-sub">Koloft runs Claude Code, Codex, Muse and Antigravity.</p>
            <div className="wl-agents">
              {SESSION_BACKENDS.map((b, i) => {
                const t = tally[b]
                const there = isInstalled(b)
                return (
                  <div
                    key={b}
                    className={'wl-agent ' + b + (there ? ' ready' : '')}
                    style={{ animationDelay: `${i * 110}ms` }}
                  >
                    <div className="wl-agent-mark">
                      <SessionBackendIcon backend={b} size={34} decorative />
                    </div>
                    <div className="wl-agent-name">{AGENT_NAME[b]}</div>
                    <div className="wl-agent-maker">{MAKER[b]}</div>
                    <div className={'wl-agent-state' + (there ? ' ok' : '')}>
                      {installed === null ? (
                        <span className="wl-faint">Looking…</span>
                      ) : there ? (
                        <>
                          <span>
                            Ready <IconCheck size={13} />
                          </span>
                          <small>
                            {t
                              ? `${plural(t.sessions, 'session')} · ${plural(t.folders, 'folder')}`
                              : 'No sessions yet'}
                          </small>
                        </>
                      ) : (
                        <>
                          <span className="wl-faint">Not on this Mac</span>
                          <button className="wl-mini" onClick={() => void install(b)}>
                            Install
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {step === 2 && emptyMac && (
          <>
            <Chip>
              {pickedFolder
                ? `${folders.map((f) => basename(f.path)).join(', ')} is pinned`
                : 'No sessions on this Mac yet'}
            </Chip>
            <Title plain="Pick a folder" script="to work in." />
            <p className="wl-sub">Any folder works; a git checkout gets extra help.</p>
            {pickedFolder ? (
              <div className="wl-win">
                <MiniSidebar folders={folders} />
              </div>
            ) : (
              <button className="ob-link wl-alt" onClick={onAddRemote}>
                A folder on another machine (SSH)
              </button>
            )}
          </>
        )}

        {step === 2 && !emptyMac && (
          <>
            <Chip busy={pinning || found === null}>
              {pinning || found === null
                ? 'Reading each tool’s history…'
                : `Found ${plural(allRows.length, 'session')} in ${plural(folders.length, 'folder')}`}
            </Chip>
            <Title plain="Everything you started," script="already here." />
            <p className="wl-sub">
              Sessions from your terminal show up on their own. <b>Nothing is copied.</b>
            </p>
            <div className="wl-two">
              <div className="wl-win">
                <MiniSidebar folders={folders} />
              </div>
              {allRows.length > 0 && <LightKey />}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <Chip>
              {signedIn(pick) ? `Signed in · ${BACKEND_LABEL[pick]}` : 'One step needs you'}
            </Chip>
            <Title plain="One sign-in." script="Koloft does the rest." />
            <p className="wl-sub">
              Koloft adds its own account and names it. Your Mac’s logins stay untouched.
            </p>
            <div className="wl-seg" role="tablist">
              {SESSION_BACKENDS.map((b) => (
                <button
                  key={b}
                  role="tab"
                  aria-selected={b === pick}
                  className={b === pick ? 'on' : ''}
                  onClick={() => {
                    setAgent(b)
                    setSignError(null)
                  }}
                >
                  <SessionBackendIcon backend={b} size={13} decorative />
                  {AGENT_NAME[b]}
                  {b === lastUsed && <em>last used</em>}
                </button>
              ))}
            </div>
            <div className="wl-sign">
              <div className="wl-sign-mark">
                <SessionBackendIcon backend={pick} size={30} decorative />
              </div>
              {signedIn(pick) ? (
                <div className="wl-sign-done">
                  <IconCheck size={18} /> Signed in to {BACKEND_LABEL[pick]}
                </div>
              ) : loginPhase === 'failed' ? (
                <div className="wl-sign-text bad">
                  The sign-in did not finish.
                  {login?.progress?.tail && <pre>{login.progress.tail}</pre>}
                </div>
              ) : claudeBusy ? (
                <div className="wl-sign-text">
                  {loginPhase === 'starting' && !isInstalled('claude')
                    ? 'Installing Claude Code, then your browser opens…'
                    : 'Finish in your browser. Koloft picks it up from there.'}
                  {login?.progress?.url && (
                    <button
                      className="ob-link"
                      onClick={() => window.api.preview.osOpen(login.progress?.url ?? '')}
                    >
                      Open the page again
                    </button>
                  )}
                </div>
              ) : (
                <div className="wl-sign-text">
                  {!isInstalled(pick) && `Koloft installs ${AGENT_NAME[pick]} first. `}
                  {SIGN_IN_HOW[pick]}
                </div>
              )}
              {signError && <div className="wl-sign-text bad">{signError}</div>}
              <div className="wl-sign-note">
                {again
                  ? `This signs “${again}” in again.`
                  : `The account is named “${accountName}”.`}{' '}
                Add more in Settings ▸ Accounts: each new session then takes the one with the most
                left.
              </div>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <Chip>
              {folders.length > 0
                ? `Ready · ${folders.map((f) => basename(f.path)).join(', ')}`
                : 'Ready'}
            </Chip>
            <Title plain="Built for you." script="And for your agents." />
            <p className="wl-sub">
              {target
                ? 'Your newest session is one key away.'
                : 'Say what you want done. That starts your first session.'}
            </p>
            <div className="wl-final">
              <div className="wl-win wide">
                <MiniSidebar folders={folders} />
                <div className="wl-win-main">
                  {target ? (
                    <div className="wl-target">
                      <SessionBackendIcon backend={target.backendId} size={16} decorative />
                      <b>{target.title}</b>
                      <small>
                        {BACKEND_LABEL[target.backendId]} · {basename(target.cwd)} ·{' '}
                        {relTime(target.mtime, Date.now())}
                      </small>
                    </div>
                  ) : (
                    <div className="wl-target empty">
                      <small>Your first session opens here.</small>
                    </div>
                  )}
                </div>
                <div className="wl-win-wb">
                  <div className="wl-wb-tabs">
                    <span className="on">Changes</span>
                    <span>Web</span>
                    <span>Shell</span>
                  </div>
                  <small>What a session changes shows up here.</small>
                </div>
              </div>
              <div className="wl-cue c-wb">
                <b>Workbench</b> files it changed · browser · shell
              </div>
              <div className="wl-cue c-p">
                <b>⌘P</b> say it in plain words
              </div>
              <div className="wl-phone">
                <div className="wl-phone-head"># alfred</div>
                <div className="wl-phone-msg">
                  <span className="wl-phone-av">
                    <IconAssist size={13} />
                  </span>
                  <div>
                    <b>Alfred</b>
                    <p>
                      Hi, I’m Alfred. Connect Discord any time, and I’ll ask you here when a session
                      needs you.
                    </p>
                  </div>
                </div>
              </div>
              <div className="wl-cue c-al">
                <b>Alfred</b> on your phone, once you connect Discord
              </div>
            </div>
          </>
        )}
      </main>

      <footer className="wl-foot">
        {step === 4 ? (
          <div className="wl-go4">
            {target && (
              <button className="wl-cta" onClick={go4} data-welcome-go>
                <span>{`Resume “${target.title}”`}</span>
                <kbd>↩</kbd>
              </button>
            )}
            <div className={'wl-ask' + (target ? '' : ' big')}>
              <IconAiStart size={15} />
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={target ? 'Or tell Koloft what to do…' : 'Try: explain this project'}
                spellCheck={false}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key !== 'Tab') return
                  e.preventDefault()
                  setChip(nextAgent(newAgent))
                }}
              />
              <button
                className="wl-agtag"
                tabIndex={-1}
                onClick={() => setChip(nextAgent(newAgent))}
              >
                <SessionBackendIcon backend={newAgent} size={12} decorative />
                {BACKEND_LABEL[newAgent]}
                <kbd>tab</kbd>
              </button>
              {(!target || prompt.trim()) && (
                <button className="wl-cta small" onClick={go4}>
                  <IconPlus size={13} />
                  Start
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="wl-go">
            <button
              className="wl-cta"
              onClick={primary.go}
              disabled={primary.disabled || primary.busy}
              data-welcome-go
            >
              {primary.busy && <IconLoading size={15} />}
              <span>{primary.label}</span>
              {!primary.busy && <kbd>↩</kbd>}
            </button>
            {step === 3 && !signedIn(pick) && !signingIn && (
              <button className="ob-link wl-alt" onClick={() => setStep(4)}>
                I’ll sign in later
              </button>
            )}
          </div>
        )}
      </footer>
    </div>,
    document.body
  )
}
