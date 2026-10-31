import { useEffect, useState } from 'react'
import {
  BACKEND_LABEL,
  SESSION_BACKENDS,
  lastOneOn,
  normalizeSessionMethods
} from '@shared/sessionBackend'
import type { BackendId } from '@shared/types'
import { useStore } from '../../store'
import { AgentSelect } from '../SessionLaunchButtons'
import { Switch } from './Switch'
import { useSettingsUpdate } from './useSettingsUpdate'

const METHOD_NOTE: Record<BackendId, string> = {
  claude: 'Runs on a Claude account from Settings ▸ Accounts',
  codex: 'Runs on a Codex account from Settings ▸ Accounts',
  muse: 'Runs on a Muse account from Settings ▸ Accounts',
  agy: 'Runs on a Google sign-in or a Gemini API key from Settings ▸ Accounts'
}

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
  const assist = useStore((s) => s.settings.assist)
  const update = useSettingsUpdate()
  const switchMethod = (backend: BackendId, on: boolean): void => {
    const next = normalizeSessionMethods({
      ...methods,
      enabled: { ...methods.enabled, [backend]: on }
    })
    update({
      sessionMethods: next,
      ...(assist && !next.enabled[assist.backend]
        ? { assist: { ...assist, backend: next.defaultBackend } }
        : {})
    })
  }
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
          <small>New session starts with this method. ⏎ starts it; ⇧⏎ picks another.</small>
        </div>
        <AgentSelect
          value={methods.defaultBackend}
          ariaLabel="Default session method"
          choice={{
            listed: SESSION_BACKENDS,
            issue: (b) => (methods.enabled[b] ? '' : `${BACKEND_LABEL[b]} is switched off below.`),
            note: () => 'Off'
          }}
          onPick={(backend) =>
            update({
              sessionMethods: normalizeSessionMethods({ ...methods, defaultBackend: backend })
            })
          }
        />
      </div>
      {SESSION_BACKENDS.map((backend) => {
        const last = methods.enabled[backend] && lastOneOn(methods, backend)
        return (
          <div className="set-row" key={backend}>
            <div className="set-lab">
              <b>{BACKEND_LABEL[backend]}</b>
              <small>{METHOD_NOTE[backend]}</small>
              <small>{status(backend)}</small>
            </div>
            <Switch
              checked={methods.enabled[backend]}
              disabled={last}
              ariaLabel={`Enable ${BACKEND_LABEL[backend]}`}
              title={
                last
                  ? `Turn on another method before turning ${BACKEND_LABEL[backend]} off`
                  : `Enable ${BACKEND_LABEL[backend]} for new sessions`
              }
              onChange={(on) => switchMethod(backend, on)}
            />
          </div>
        )
      })}
    </>
  )
}
