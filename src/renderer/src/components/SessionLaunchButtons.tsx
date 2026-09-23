import { useEffect, useRef, useState } from 'react'
import { SESSION_BACKENDS, SESSION_CAPABILITIES } from '@shared/sessionBackend'
import type { BackendId } from '@shared/types'
import { backendLabel, launchErrorMessage } from '../agentUi'
import { useStore } from '../store'
import { SessionBackendIcon } from './SessionBackendIcon'

export type SessionLaunchOptions = { cwd: string; worktree?: string; worktreeResourceId?: string }
export type StartSession = (opts: SessionLaunchOptions, backend: BackendId) => Promise<void>

export function useSessionLaunch(remote: boolean, onStart: StartSession, onClose: () => void) {
  const methods = useStore((s) => s.settings.sessionMethods)
  const [detected, setDetected] = useState<Awaited<
    ReturnType<typeof window.api.sessions.backends>
  > | null>(null)
  const [claudeFound, setClaudeFound] = useState<boolean | null>(null)
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
  // Two separate asks, because one failing must not take the other down with it: a
  // machine without Codex was marking Claude unprobed too.
  useEffect(() => {
    let alive = true
    setDetected(null)
    setClaudeFound(null)
    setProbeError('')
    void window.api.sessions.backends().then(
      (backends) => {
        if (alive) setDetected(backends)
      },
      () => {
        if (alive) setDetected([])
      }
    )
    void window.api.claude.probe().then(
      (claude) => {
        if (alive) setClaudeFound(claude.found)
      },
      () => {
        if (alive) setProbeError('Could not check that Claude Code is installed.')
      }
    )
    return () => {
      alive = false
    }
  }, [retry])
  /** Enabled in settings, allowed here, and actually on this Mac. A probe still in
   *  flight is not a No — see `issue`. */
  const usable = (backend: BackendId, onRemote = remote): boolean => {
    if (!methods.enabled[backend]) return false
    if (onRemote && !SESSION_CAPABILITIES[backend].remote) return false
    if (backend === 'claude') return claudeFound !== false
    return !!detected?.find((b) => b.id === backend)?.available
  }
  /** Why this method cannot start here, or '' — including while the probes are still
   *  out. ⌘N ⏎ is this app's signature gesture and it may never wait on a login shell;
   *  main refuses an unavailable method anyway, in its own words. */
  const issue = (backend: BackendId, onRemote = remote): string => {
    if (!methods.enabled[backend]) return 'Disabled in Settings ▸ Sessions'
    if (onRemote) return SESSION_CAPABILITIES[backend].remote ? '' : 'Local only'
    if (backend === 'claude') return claudeFound === false ? 'Not installed' : ''
    const result = detected?.find((b) => b.id === backend)
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
    /** D1: the methods that get a button. Claude always has one — it is the method this
     *  app is built around, and a missing `claude` is worth saying out loud. */
    usable: SESSION_BACKENDS.filter((b) => b === 'claude' || usable(b)),
    issue,
    launch,
    starting,
    error,
    retry: () => setRetry((n) => n + 1),
    probeError
  }
}

/**
 * D1: only a method the user can actually pick gets a button, because a greyed door
 * still says there is a room here (App.tsx's rule for a remote session's Workbench).
 * The label comes from the caller — the dialog is the one that knows the whole action
 * the button performs (D12).
 */
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
  // The existing primary action stays at the right edge of the dialog footer.
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
  // A Claude-only user never reads a word about Codex: with no button to explain, the
  // line would be noise. Making Codex the default is the one hands-on signal that the
  // user is waiting for it, and then its absence is the thing they need to know.
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
              {backendLabel(backend)}: {reason === 'Local only' ? reason : 'Unavailable'}
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
