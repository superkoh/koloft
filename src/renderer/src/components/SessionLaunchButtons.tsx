import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { IconChevronDown, IconLoading } from '../icons'
import {
  BACKEND_LABEL,
  backendAvailable,
  byBackend,
  effectiveBackend,
  listedBackends
} from '@shared/sessionBackend'
import { ACCOUNTS_PANE, noUsableAccountLead } from '@shared/accountUsage'
import type { BackendId, CreateTabOptions, HostId } from '@shared/types'
import { firstHot, type AgentChoice } from '../agentChoice'
import { launchErrorMessage } from '../agentUi'
import { isComposing } from '../keys'
import { useStore } from '../store'
import { useInstalledBackends } from '../useInstalledBackends'
import { SessionBackendIcon } from './SessionBackendIcon'
import { dropPosFor } from './WorkspaceSidebar'
import '../workspacePicker.css'

export type SessionLaunchOptions = Pick<
  CreateTabOptions,
  'worktree' | 'worktreeResourceId' | 'firstPrompt' | 'name' | 'trustFolder'
> & { cwd: string }
export type StartSession = (opts: SessionLaunchOptions, backend: BackendId) => Promise<void>

export function useLaunchChoice(host: HostId) {
  const methods = useStore((s) => s.settings.sessionMethods)
  const [retry, setRetry] = useState(0)
  const { installed: detected, checkFailed } = useInstalledBackends(retry)
  const accountIssue = useAccountIssue()
  const found = (backend: BackendId) => detected?.find((b) => b.id === backend)
  const listed = listedBackends(methods, detected && ((b) => backendAvailable(detected, b)))
  const setupIssue = (backend: BackendId, on = host): string => {
    if (!methods.enabled[backend]) return 'Disabled in Settings ▸ Sessions'
    if (on === 'ssh') return ''
    const result = found(backend)
    return !detected || result?.available ? '' : result?.reason || 'Not installed'
  }
  const issue = (backend: BackendId, on = host): string =>
    setupIssue(backend, on) || accountIssue(backend)
  const note = (backend: BackendId, on = host): string =>
    setupIssue(backend, on) ? 'Unavailable' : accountIssue(backend) ? 'No account' : ''
  const choice = ({
    on = host,
    backends = listed,
    chosen
  }: { on?: HostId; backends?: BackendId[]; chosen?: BackendId } = {}): AgentChoice => ({
    listed: backends,
    lead: chosen ?? effectiveBackend(methods, new Set(backends.filter((b) => !setupIssue(b, on)))),
    defaultBackend: methods.defaultBackend,
    issue: (b) => issue(b, on),
    note: (b) => note(b, on)
  })
  return {
    listed,
    setupIssue,
    issue,
    note,
    choice,
    retry: () => setRetry((n) => n + 1),
    checkFailed
  }
}

export function useSessionLaunch(host: HostId, onStart: StartSession, onClose: () => void) {
  const options = useLaunchChoice(host)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const launch = async (
    opts: SessionLaunchOptions | (() => Promise<SessionLaunchOptions>),
    backend: BackendId
  ): Promise<void> => {
    if (submitting.current) return
    submitting.current = true
    setStarting(true)
    setError('')
    try {
      await onStart(typeof opts === 'function' ? await opts() : opts, backend)
      if (live.current) onClose()
    } catch (e) {
      if (live.current) setError(launchErrorMessage(e))
    } finally {
      submitting.current = false
      if (live.current) setStarting(false)
    }
  }
  return { ...options, launch, close: onClose, starting, error }
}

const keepFocus = (e: MouseEvent): void => e.preventDefault()

export function SessionLaunchButtons({
  choice,
  open,
  onOpen,
  label,
  onStart,
  disabled,
  busy,
  className = 'btn-primary',
  icon = true,
  keyHint = true
}: {
  choice: AgentChoice
  open: boolean
  onOpen: (open: boolean) => void
  label: (backend: BackendId) => ReactNode
  onStart: (backend: BackendId) => void
  disabled: boolean
  busy: boolean
  className?: string
  icon?: boolean
  keyHint?: boolean
}) {
  const [caret, setCaret] = useState<HTMLButtonElement | null>(null)
  const { listed, lead } = choice
  const many = listed.length > 1
  const reason = choice.issue(lead)
  const start = (
    <button
      className={className}
      data-default="true"
      disabled={disabled || !!reason}
      title={reason || undefined}
      onMouseDown={keepFocus}
      onClick={() => onStart(lead)}
    >
      {icon && many && <SessionBackendIcon backend={lead} size={14} decorative />}
      {label(lead)}
      {!busy && keyHint && <span className="k">⏎</span>}
    </button>
  )
  if (!many) return start
  return (
    <div className="split">
      {start}
      <button
        ref={setCaret}
        className={className}
        aria-label="Pick an agent"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={keepFocus}
        onClick={() => onOpen(!open)}
      >
        <IconChevronDown size={14} />
      </button>
      {open && caret && (
        <AgentList
          anchor={caret}
          choice={choice}
          hotAt={firstHot(choice)}
          numbered
          onPick={onStart}
          onClose={() => onOpen(false)}
        />
      )}
    </div>
  )
}

const AGENT_ROW_H = 30
const AGENT_LIST_W = 240

export function AgentList({
  anchor,
  choice,
  hotAt,
  numbered,
  onPick,
  onClose
}: {
  anchor: HTMLElement
  choice: Pick<AgentChoice, 'listed' | 'defaultBackend' | 'issue' | 'note'>
  hotAt: number
  numbered: boolean
  onPick: (backend: BackendId) => void
  onClose: () => void
}) {
  const { listed, issue } = choice
  const [hot, setHot] = useState(hotAt)
  const [pos] = useState(() => dropPosFor(anchor, listed.length, AGENT_ROW_H, AGENT_LIST_W))
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const back = document.activeElement
    box.current?.focus()
    return () => {
      if (back instanceof HTMLElement && document.activeElement === document.body) back.focus()
    }
  }, [])

  useEffect(() => {
    const outside = (e: PointerEvent): void => {
      const t = e.target
      if (t instanceof Node && !box.current?.contains(t) && !anchor.contains(t)) onClose()
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [anchor, onClose])

  const pick = (i: number): void => {
    const backend = listed[i]
    if (!backend || issue(backend)) return
    onClose()
    onPick(backend)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    if (isComposing(e)) return
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') setHot((h) => Math.min(h + 1, listed.length - 1))
    else if (e.key === 'ArrowUp') setHot((h) => Math.max(h - 1, 0))
    else if (e.key === 'Enter') pick(hot)
    else if (numbered && /^[1-9]$/.test(e.key)) pick(Number(e.key) - 1)
    else return
    e.preventDefault()
  }

  return createPortal(
    // ADR-0013
    <div
      ref={box}
      className="menu wt-list"
      role="listbox"
      aria-label="Agents"
      tabIndex={-1}
      style={pos}
      onKeyDown={onKeyDown}
      onBlur={onClose}
    >
      {listed.map((backend, i) => {
        const reason = issue(backend)
        return (
          <div
            key={backend}
            className={'cb-row' + (reason ? ' dim' : '') + (i === hot ? ' hot' : '')}
            role="option"
            aria-selected={i === hot}
            aria-disabled={!!reason || undefined}
            title={reason || undefined}
            onMouseDown={keepFocus}
            onClick={() => pick(i)}
          >
            {numbered && <span className="wsp-num">{i + 1}</span>}
            <SessionBackendIcon backend={backend} size={14} decorative />
            <span className="wsp-name">{BACKEND_LABEL[backend]}</span>
            <span className="note">
              {reason ? choice.note(backend) : backend === choice.defaultBackend ? 'default' : ''}
            </span>
          </div>
        )
      })}
    </div>,
    document.body
  )
}

export function AgentSelect({
  value,
  choice,
  ariaLabel,
  onPick
}: {
  value: BackendId
  choice: Pick<AgentChoice, 'listed' | 'issue' | 'note'>
  ariaLabel: string
  onPick: (backend: BackendId) => void
}) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  return (
    <>
      <button
        ref={setAnchor}
        className="mini"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onMouseDown={keepFocus}
        onClick={() => setOpen(!open)}
      >
        <SessionBackendIcon backend={value} size={14} decorative />
        {BACKEND_LABEL[value]}
        <IconChevronDown size={14} />
      </button>
      {open && anchor && (
        <AgentList
          anchor={anchor}
          choice={{ ...choice, defaultBackend: value }}
          hotAt={Math.max(0, choice.listed.indexOf(value))}
          numbered={false}
          onPick={onPick}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function useNoAccountLeads(): Record<BackendId, string> {
  const accounts = useStore((s) => s.accounts)
  return byBackend((b) => (accounts ? noUsableAccountLead(accounts, b) : ''))
}

export function useAccountIssue(): (backend: BackendId) => string {
  const leads = useNoAccountLeads()
  return (backend) => leads[backend] && `${leads[backend]}${ACCOUNTS_PANE}.`
}

export function NoAccountLines({
  backends,
  onOpenSettings
}: {
  backends: BackendId[]
  onOpenSettings?: () => void
}) {
  const leads = useNoAccountLeads()
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  return (
    <>
      {backends.map((b) => {
        const lead = leads[b]
        return (
          lead && (
            <p key={b} className="field-hint bad">
              {lead}
              <button
                className="ob-link"
                onClick={() => {
                  onOpenSettings?.()
                  setSettingsOpen(true)
                }}
              >
                {ACCOUNTS_PANE}
              </button>
              .
            </p>
          )
        )
      })}
    </>
  )
}

export function BusyLine({ children }: { children: ReactNode }) {
  return (
    <div className="fresh-line busy">
      <span className="fico-l">
        <IconLoading size={14} />
      </span>
      <span>{children}</span>
    </div>
  )
}

export function SessionLaunchStatus({
  launch
}: {
  launch: ReturnType<typeof useLaunchChoice> & { error?: string; close?: () => void }
}) {
  const refused = launch.listed.filter((b) => launch.setupIssue(b))
  return (
    <>
      <NoAccountLines
        backends={launch.listed.filter((b) => !launch.setupIssue(b))}
        onOpenSettings={launch.close}
      />
      {refused.length > 0 && (
        <p className="field-hint">
          {refused.map((backend, index) => (
            <span key={backend} title={launch.setupIssue(backend)}>
              {index > 0 && ' · '}
              {BACKEND_LABEL[backend]}: {launch.note(backend)}
            </span>
          ))}
        </p>
      )}
      {launch.error && (
        <p className="field-hint bad" role="alert">
          {launch.error}
        </p>
      )}
      {launch.checkFailed && (
        <button className="mini" onClick={launch.retry}>
          Retry
        </button>
      )}
    </>
  )
}
