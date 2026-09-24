import { useEffect, useRef, useState } from 'react'
import { BACKEND_LABEL, SESSION_BACKENDS, SUPPORTED_PAIRS } from '@shared/sessionBackend'
import type { BackendId, HostId } from '@shared/types'
import { launchErrorMessage } from '../agentUi'
import { useStore } from '../store'
import { SessionBackendIcon } from './SessionBackendIcon'

export type SessionLaunchOptions = { cwd: string; worktree?: string; worktreeResourceId?: string }
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
  const found = (backend: BackendId) => detected?.find((b) => b.id === backend)
  const usable = (backend: BackendId, on = host): boolean => {
    if (!methods.enabled[backend]) return false
    if (!SUPPORTED_PAIRS[backend][on]) return false
    if (backend === 'claude') return found(backend)?.available !== false
    return !!found(backend)?.available
  }
  const issue = (backend: BackendId, on = host): string => {
    if (!methods.enabled[backend]) return 'Disabled in Settings ▸ Sessions'
    if (on === 'ssh') return SUPPORTED_PAIRS[backend][on] ? '' : 'Local only'
    const result = found(backend)
    if (backend === 'claude') return result?.available === false ? 'Not installed' : ''
    return !detected || result?.available ? '' : result?.reason || 'Not installed'
  }
  const launch = async (opts: SessionLaunchOptions, backend: BackendId): Promise<void> => {
    if (submitting.current) return
    submitting.current = true
    setStarting(true)
    setError('')
    try {
      await onStart(opts, backend)
      if (live.current) onClose()
    } catch (e) {
      if (live.current) setError(launchErrorMessage(e))
    } finally {
      submitting.current = false
      if (live.current) setStarting(false)
    }
  }
  return {
    methods,
    usable: SESSION_BACKENDS.filter((b) => b === 'claude' || usable(b)),
    issue,
    launch,
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

export function SessionLaunchStatus({ launch }: { launch: ReturnType<typeof useSessionLaunch> }) {
  const watched =
    launch.methods.defaultBackend === 'codex' ? SESSION_BACKENDS : (['claude'] as const)
  const issues = watched.flatMap((b) => {
    const reason = launch.methods.enabled[b] ? launch.issue(b) : ''
    return reason ? [{ backend: b, reason }] : []
  })
  return (
    <>
      {issues.length > 0 && (
        <p className="field-hint">
          {issues.map(({ backend, reason }, index) => (
            <span key={backend} title={reason}>
              {index > 0 && ' · '}
              {BACKEND_LABEL[backend]}: {reason === 'Local only' ? reason : 'Unavailable'}
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
