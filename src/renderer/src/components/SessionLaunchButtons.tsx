import { useEffect, useRef, useState } from 'react'
import {
  backendAvailable,
  BACKEND_LABEL,
  SESSION_BACKENDS,
  unsupportedPairMessage
} from '@shared/sessionBackend'
import { ACCOUNTS_PANE, noUsableAccountLead } from '@shared/accountUsage'
import type { BackendId, CreateTabOptions, HostId } from '@shared/types'
import { launchErrorMessage } from '../agentUi'
import { useStore } from '../store'
import { SessionBackendIcon } from './SessionBackendIcon'

export type SessionLaunchOptions = Pick<
  CreateTabOptions,
  'worktree' | 'worktreeResourceId' | 'firstPrompt' | 'name' | 'trustFolder'
> & { cwd: string }
export type StartSession = (opts: SessionLaunchOptions, backend: BackendId) => Promise<void>

export function useSessionLaunch(host: HostId, onStart: StartSession, onClose: () => void) {
  const methods = useStore((s) => s.settings.sessionMethods)
  const [detected, setDetected] = useState<Awaited<
    ReturnType<typeof window.api.sessions.backends>
  > | null>(null)
  const [probeError, setProbeError] = useState('')
  const [retry, setRetry] = useState(0)
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
  useEffect(() => {
    let alive = true
    setDetected(null)
    setProbeError('')
    void window.api.sessions.backends().then(
      (backends) => {
        if (alive) setDetected(backends)
      },
      () => {
        if (alive) setProbeError('Could not check that Claude Code is installed.')
      }
    )
    return () => {
      alive = false
    }
  }, [retry])
  const accountIssue = useAccountIssue()
  const found = (backend: BackendId) => detected?.find((b) => b.id === backend)
  const usable = (backend: BackendId, on = host): boolean =>
    methods.enabled[backend] &&
    !unsupportedPairMessage(backend, on) &&
    (!detected || backendAvailable(detected, backend))
  const setupIssue = (backend: BackendId, on = host): string => {
    if (!methods.enabled[backend]) return 'Disabled in Settings ▸ Sessions'
    const refusal = unsupportedPairMessage(backend, on)
    if (refusal || on === 'ssh') return refusal ?? ''
    const result = found(backend)
    return !detected || result?.available ? '' : result?.reason || 'Not installed'
  }
  const issue = (backend: BackendId, on = host): string =>
    setupIssue(backend, on) || accountIssue(backend)
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
  return {
    host,
    methods,
    usable: SESSION_BACKENDS.filter((b) => b === 'claude' || usable(b)),
    setupIssue,
    issue,
    launch,
    close: onClose,
    starting,
    error,
    retry: () => setRetry((n) => n + 1),
    probeError
  }
}

export function SessionLaunchButtons({
  launch,
  backends,
  disabled,
  busy,
  label,
  onStart,
  issue = launch.issue
}: {
  launch: ReturnType<typeof useSessionLaunch>
  backends: BackendId[]
  disabled: boolean
  busy: boolean
  label: (backend: BackendId, isDefault: boolean) => string
  onStart: (backend: BackendId) => void
  issue?: (backend: BackendId) => string
}) {
  const ordered = [...backends].sort(
    (a, b) =>
      Number(a === launch.methods.defaultBackend) - Number(b === launch.methods.defaultBackend)
  )
  return (
    <>
      {ordered.map((backend) => {
        const isDefault = backend === launch.methods.defaultBackend || ordered.length === 1
        const reason = issue(backend)
        return (
          <button
            key={backend}
            className={isDefault ? 'btn-primary' : 'mini'}
            data-default={isDefault}
            disabled={disabled || !!reason}
            title={reason || undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onStart(backend)}
          >
            {ordered.length > 1 && <SessionBackendIcon backend={backend} size={14} decorative />}
            {label(backend, isDefault)}
            {!busy && <span className="k">{isDefault ? '⏎' : '⇧⏎'}</span>}
          </button>
        )
      })}
    </>
  )
}

function useNoAccountLeads(): Record<BackendId, string> {
  const claude = useStore((s) => (s.accounts ? noUsableAccountLead(s.accounts, 'claude') : ''))
  const codex = useStore((s) => (s.accounts ? noUsableAccountLead(s.accounts, 'codex') : ''))
  return { claude, codex }
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

export function SessionLaunchStatus({ launch }: { launch: ReturnType<typeof useSessionLaunch> }) {
  const watched =
    launch.methods.defaultBackend === 'codex' ? SESSION_BACKENDS : (['claude'] as const)
  const issues = watched.flatMap((b) => {
    const reason = launch.methods.enabled[b] ? launch.setupIssue(b) : ''
    return reason ? [{ backend: b, reason }] : []
  })
  return (
    <>
      <NoAccountLines
        backends={launch.usable.filter((b) => !launch.setupIssue(b))}
        onOpenSettings={launch.close}
      />
      {issues.length > 0 && (
        <p className="field-hint">
          {issues.map(({ backend, reason }, index) => (
            <span key={backend} title={reason}>
              {index > 0 && ' · '}
              {BACKEND_LABEL[backend]}:{' '}
              {unsupportedPairMessage(backend, launch.host) ? 'Local only' : 'Unavailable'}
            </span>
          ))}
        </p>
      )}
      {launch.error && (
        <p className="field-hint bad" role="alert">
          {launch.error}
        </p>
      )}
      {launch.probeError && (
        <button className="mini" onClick={launch.retry}>
          Retry
        </button>
      )}
    </>
  )
}
