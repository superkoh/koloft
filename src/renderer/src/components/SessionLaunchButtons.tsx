import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconLoading } from '../icons'
import {
  ALWAYS_ON_BACKEND,
  BACKEND_LABEL,
  SESSION_BACKENDS,
  byBackend,
  shownAsInstalled,
  unsupportedPairMessage
} from '@shared/sessionBackend'
import { ACCOUNTS_PANE, noUsableAccountLead } from '@shared/accountUsage'
import type { BackendId, CreateTabOptions, HostId } from '@shared/types'
import { launchErrorMessage } from '../agentUi'
import { useStore } from '../store'
import { useInstalledBackends } from '../useInstalledBackends'
import { SessionBackendIcon } from './SessionBackendIcon'

export type SessionLaunchOptions = Pick<
  CreateTabOptions,
  'worktree' | 'worktreeResourceId' | 'firstPrompt' | 'name' | 'trustFolder'
> & { cwd: string }
export type StartSession = (opts: SessionLaunchOptions, backend: BackendId) => Promise<void>

export function useSessionLaunch(host: HostId, onStart: StartSession, onClose: () => void) {
  const methods = useStore((s) => s.settings.sessionMethods)
  const [retry, setRetry] = useState(0)
  const { installed: detected, checkFailed } = useInstalledBackends(retry)
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
  const accountIssue = useAccountIssue()
  const found = (backend: BackendId) => detected?.find((b) => b.id === backend)
  const usable = (backend: BackendId, on = host): boolean =>
    methods.enabled[backend] &&
    !unsupportedPairMessage(backend, on) &&
    shownAsInstalled(detected, backend)
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
    usable: SESSION_BACKENDS.filter((b) => b === ALWAYS_ON_BACKEND || usable(b)),
    setupIssue,
    issue,
    launch,
    close: onClose,
    starting,
    error,
    retry: () => setRetry((n) => n + 1),
    checkFailed
  }
}

export function otherMethods(backends: BackendId[], defaultBackend: BackendId): BackendId[] {
  return backends.length > 1 ? backends.filter((b) => b !== defaultBackend) : []
}

export function enterMethod(
  e: { shiftKey: boolean; ctrlKey: boolean },
  [shiftEnterBackend, ctrlEnterBackend]: BackendId[]
): BackendId | undefined {
  if (e.ctrlKey && ctrlEnterBackend) return ctrlEnterBackend
  return e.shiftKey ? shiftEnterBackend : undefined
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
  const [shiftEnterBackend, ctrlEnterBackend] = otherMethods(ordered, launch.methods.defaultBackend)
  return (
    <>
      {ordered.map((backend) => {
        const isDefault = backend === launch.methods.defaultBackend || ordered.length === 1
        const key = isDefault
          ? '⏎'
          : backend === shiftEnterBackend
            ? '⇧⏎'
            : backend === ctrlEnterBackend
              ? '⌃⏎'
              : undefined
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
            {!busy && key && <span className="k">{key}</span>}
          </button>
        )
      })}
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

export function SessionLaunchStatus({ launch }: { launch: ReturnType<typeof useSessionLaunch> }) {
  const watched = [...new Set([ALWAYS_ON_BACKEND, launch.methods.defaultBackend])]
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
      {launch.checkFailed && (
        <button className="mini" onClick={launch.retry}>
          Retry
        </button>
      )}
    </>
  )
}
