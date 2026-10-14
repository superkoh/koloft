import type { JSX } from 'react'
import { ASSIST_BACKENDS, BACKEND_LABEL } from '@shared/sessionBackend'
import { useStore } from '../../store'
import { useAssistSetup } from '../../useAssistSetup'
import { ASSIST_COST_LINE, ASSIST_RUNS_ON } from '../AssistSetup'
import { SessionBackendIcon } from '../SessionBackendIcon'
import { Switch } from './Switch'
import { useSettingsUpdate } from './useSettingsUpdate'

const ASSIST_SESSIONS_FOLLOW =
  'Assist sessions run on it too, Discord ones included. A change applies the next time each one starts.'

export function AssistSection(): JSX.Element {
  const assist = useStore((s) => s.settings.assist)
  const update = useSettingsUpdate()
  const setup = useAssistSetup()
  const on = assist?.on ?? false
  return (
    <>
      <div className="set-grp">Assist</div>
      <div className="set-row">
        <div className="set-lab">
          <b>Koloft Assist</b>
          <small>
            Koloft asks an AI for small jobs, like naming a new session, and you can talk to Assist
            from the sidebar. {ASSIST_COST_LINE} Off, Koloft does those jobs without AI. Assist on
            Discord keeps working either way.
          </small>
        </div>
        <Switch
          checked={on}
          disabled={!assist}
          ariaLabel="Koloft Assist"
          onChange={(next) => assist && update({ assist: { ...assist, on: next } })}
        />
      </div>
      <div className="set-row child">
        <div className="set-lab">
          <b>Runs on</b>
          {ASSIST_BACKENDS.map((b) => (
            <small key={b} className={setup.usable[b] ? undefined : 'ob-warn'}>
              {BACKEND_LABEL[b]} ·{' '}
              {setup.usable[b] ? ASSIST_RUNS_ON[b] : 'no account — add one in Settings ▸ Accounts'}
            </small>
          ))}
          <small>{ASSIST_SESSIONS_FOLLOW}</small>
        </div>
        <div className="seg" role="group" aria-label="Koloft Assist runs on">
          {ASSIST_BACKENDS.map((b) => (
            <button
              key={b}
              className={assist?.backend === b ? 'on' : ''}
              aria-pressed={assist?.backend === b}
              disabled={!setup.usable[b]}
              onClick={() => update({ assist: { on: assist?.on ?? true, backend: b } })}
            >
              <SessionBackendIcon backend={b} size={14} decorative />
              {BACKEND_LABEL[b]}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
