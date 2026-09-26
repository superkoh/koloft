import { useEffect, useState } from 'react'
import { BACKEND_LABEL, SESSION_BACKENDS, normalizeSessionMethods } from '@shared/sessionBackend'
import type { BackendId } from '@shared/types'
import { useStore } from '../../store'
import { SessionBackendIcon } from '../SessionBackendIcon'
import { Switch } from './Switch'
import { useSettingsUpdate } from './useSettingsUpdate'

type Detected = Awaited<ReturnType<typeof window.api.sessions.backends>>

function statusLine(found: Detected[number] | undefined): string {
  if (!found) return 'Checking…'
  if (!found.available) return found.reason || 'Not installed'
  if (!found.version) return 'Found'
  return found.verified === false
    ? `${found.version} · newer than tested`
    : `${found.version} · found`
}

export function SessionMethodsSection() {
  const methods = useStore((s) => s.settings.sessionMethods)
  const update = useSettingsUpdate()
  const [detected, setDetected] = useState<Detected | 'error' | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.sessions.backends().then(
      (backends) => {
        if (alive) setDetected(backends)
      },
      () => {
        if (alive) setDetected('error')
      }
    )
    return () => {
      alive = false
    }
  }, [])
  const status = (backend: BackendId): string => {
    if (detected === 'error') return 'Could not check this Mac.'
    if (!detected) return 'Checking…'
    return statusLine(detected.find((b) => b.id === backend))
  }
  return (
    <>
      <div className="set-grp">Session methods</div>
      <div className="set-row">
        <div className="set-lab">
          <b>Default method</b>
          <small>
            New session starts with this method. With several workspaces, Enter picks it and ⇧⏎ the
            other one.
          </small>
        </div>
        <div className="seg" role="group" aria-label="Default session method">
          {SESSION_BACKENDS.map((backend) => (
            <button
              key={backend}
              className={methods.defaultBackend === backend ? 'on' : ''}
              aria-pressed={methods.defaultBackend === backend}
              aria-label={`Use ${BACKEND_LABEL[backend]} by default`}
              disabled={!methods.enabled[backend]}
              onClick={() =>
                update({
                  sessionMethods: normalizeSessionMethods({ ...methods, defaultBackend: backend })
                })
              }
            >
              <SessionBackendIcon backend={backend} size={14} decorative />
              {BACKEND_LABEL[backend]}
            </button>
          ))}
        </div>
      </div>
      {SESSION_BACKENDS.map((backend) => (
        <div className="set-row" key={backend}>
          <div className="set-lab">
            <b>{BACKEND_LABEL[backend]}</b>
            <small>
              {backend === 'claude'
                ? 'Always enabled'
                : 'Uses Settings ▸ Accounts, or its own login on this Mac'}
            </small>
            <small>{status(backend)}</small>
          </div>
          <Switch
            checked={methods.enabled[backend]}
            disabled={backend === 'claude'}
            ariaLabel={`Enable ${BACKEND_LABEL[backend]}`}
            title={
              backend === 'claude' ? 'Claude is always enabled' : 'Enable Codex for new sessions'
            }
            onChange={(on) =>
              update({
                sessionMethods: normalizeSessionMethods({
                  ...methods,
                  enabled: { ...methods.enabled, [backend]: on }
                })
              })
            }
          />
        </div>
      ))}
    </>
  )
}
