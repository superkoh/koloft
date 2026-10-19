import { useEffect, useState, type JSX } from 'react'
import { BACKEND_LABEL, preferredAssistBackend, SESSION_BACKENDS } from '@shared/sessionBackend'
import { butlerName, butlerTitle } from '@shared/conductors'
import { useStore } from '../../store'
import { useAssistSetup } from '../../useAssistSetup'
import { ASSIST_COST_LINE, ASSIST_RUNS_ON } from '../AssistSetup'
import { AgentSelect } from '../SessionLaunchButtons'
import { Switch } from './Switch'
import { useSettingsUpdate } from './useSettingsUpdate'

const NO_ACCOUNT_LINE = 'no account — add one in Settings ▸ Accounts'

export function AssistSection(): JSX.Element {
  const assist = useStore((s) => s.settings.assist)
  const name = useStore((s) => s.settings.butler.name)
  const runsOn = useStore((s) => preferredAssistBackend(s.settings))
  const update = useSettingsUpdate()
  const setup = useAssistSetup()
  const on = assist?.on ?? false
  const [nameDraft, setNameDraft] = useState(name)
  useEffect(() => setNameDraft(name), [name])

  const commitName = (): void => {
    const next = butlerName(nameDraft)
    setNameDraft(next)
    if (next !== name) update({ butler: { name: next } })
  }

  return (
    <>
      <div className="set-grp">Assist</div>
      <div className="set-row">
        <div className="set-lab">
          <b>Koloft Assist</b>
          <small>
            Koloft asks an AI for small jobs, like naming a new session. {ASSIST_COST_LINE} Off,
            Koloft does those jobs without AI. {name}, your butler, keeps working either way.
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
          {SESSION_BACKENDS.map((b) => (
            <small key={b} className={setup.usable[b] ? undefined : 'ob-warn'}>
              {BACKEND_LABEL[b]} · {setup.usable[b] ? ASSIST_RUNS_ON[b] : NO_ACCOUNT_LINE}
            </small>
          ))}
          <small>{name} runs on it too. A change applies the next time it starts.</small>
        </div>
        <AgentSelect
          value={runsOn}
          ariaLabel="Koloft Assist runs on"
          choice={{
            listed: SESSION_BACKENDS,
            issue: (b) => (setup.usable[b] ? '' : NO_ACCOUNT_LINE),
            note: () => 'No account'
          }}
          onPick={(b) => update({ assist: { on: assist?.on ?? true, backend: b } })}
        />
      </div>
      <div className="set-row">
        <div className="set-lab">
          <b>Name</b>
          <small>
            Your butler’s name, shown as “{butlerTitle(name)}” at the top of the sidebar. Other
            sessions reach it by this name.
          </small>
        </div>
        <input
          className="set-input"
          type="text"
          aria-label="Butler name"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName()
          }}
          spellCheck={false}
        />
      </div>
    </>
  )
}
