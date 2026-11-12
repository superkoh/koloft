import { useEffect, useState, type JSX } from 'react'
import {
  ASSIST_DEFAULTS,
  assistEfforts,
  assistModels,
  assistRunsOn,
  withAssistPick
} from '@shared/assistPicks'
import { CRON_SAVE_MESSAGES } from '@shared/cronMessages'
import { takenEffort } from '@shared/cronModels'
import { isValidModelName } from '@shared/cronNames'
import { butlerName, butlerTitle, renamedButler } from '@shared/conductors'
import { BACKEND_LABEL, SESSION_BACKENDS } from '@shared/sessionBackend'
import { ASSIST_JOBS, type AssistPick, type AssistRowId, type BackendId } from '@shared/types'
import { IconChevronDown, IconChevronUp } from '../../icons'
import { useStore } from '../../store'
import { useAssistSetup, type AssistSetupState } from '../../useAssistSetup'
import { ASSIST_COST_LINE } from '../AssistSetup'
import { effortLabel, ModelAndThinking, OTHER_MODEL } from '../ModelAndThinking'
import { AgentSelect } from '../SessionLaunchButtons'
import { useSettingsUpdate } from './useSettingsUpdate'
import '../../cronJobs.css'

const NO_ACCOUNT_LINE = 'no account — add one in Settings ▸ Accounts'

const JOB_COPY: Record<(typeof ASSIST_JOBS)[number], { title: string; does: string }> = {
  title: {
    title: 'Name a new session',
    does: 'A short title for a session that an agent or your butler starts.'
  },
  handover: {
    title: 'Translate a handover',
    does: 'The note a new session gets, in your language.'
  },
  turn: {
    title: 'After each turn',
    does: 'Decides whether a reply needs you or is only news, and offers one-click answers.'
  },
  docs: {
    title: 'Pick the documents to show',
    does: 'Which files written in a turn are for you to read.'
  },
  route: {
    title: 'Route what you type in ⌘P',
    does: 'Finds the workspace, session or feature your words are for.'
  }
}

const SMALL_JOB_WAIT_HINT =
  'A small job waits 15 seconds for its answer, 30 on Codex. A bigger model or more thinking is slower; when no answer comes, Koloft does the job without AI.'

function useAgentChoice(setup: AssistSetupState): {
  listed: BackendId[]
  issue(b: BackendId): string
  note(b: BackendId): string
} {
  const methods = useStore((s) => s.settings.sessionMethods)
  return {
    listed: SESSION_BACKENDS,
    issue: (b) =>
      !methods.enabled[b]
        ? `${BACKEND_LABEL[b]} is switched off in Settings ▸ Sessions.`
        : setup.usable[b]
          ? ''
          : NO_ACCOUNT_LINE,
    note: (b) => (methods.enabled[b] ? 'No account' : 'Off')
  }
}

function modelLabel(row: AssistRowId, backend: BackendId, model: string): string {
  return assistModels(row, backend).find((m) => m.id === model)?.label ?? model
}

function whatDefaultIs(row: AssistRowId, backend: BackendId): string {
  const { model, effort } = ASSIST_DEFAULTS[row][backend]
  const parts = [
    model && modelLabel(row, backend, model),
    effort && `${effortLabel(effort)} thinking`
  ].filter(Boolean)
  const own = `${BACKEND_LABEL[backend]}’s own`
  if (!parts.length) return `${own} model and thinking`
  return parts.join(', ') + (model ? '' : `, on ${own} model`)
}

function AssistRow({
  row,
  title,
  does,
  setup
}: {
  row: AssistRowId
  title: string
  does: string
  setup: AssistSetupState
}): JSX.Element {
  const assist = useStore((s) => s.settings.assist)
  const runsOn = useStore((s) => assistRunsOn(s.settings))
  const update = useSettingsUpdate()
  const choice = useAgentChoice(setup)
  const [open, setOpen] = useState(false)
  const [otherDraft, setOtherDraft] = useState<string | null>(null)

  const pick = assist.rows?.[row]
  const backend = pick?.backend ?? runsOn
  const named = pick?.model && assistModels(row, backend).some((m) => m.id === pick.model)
  const typedModel = otherDraft ?? (pick?.model && !named ? pick.model : null)
  const efforts = assistEfforts(row, backend, pick?.model ?? ASSIST_DEFAULTS[row][backend].model)

  const save = (next: Omit<AssistPick, 'backend'>, on = backend): void => {
    const nothingOfItsOwn = on === runsOn && !next.model && !next.effort
    update({
      assist: withAssistPick(assist, row, nothingOfItsOwn ? undefined : { ...next, backend: on })
    })
  }
  const withModel = (model: string | undefined): void => {
    const kept = takenEffort(backend, model ?? ASSIST_DEFAULTS[row][backend].model, pick?.effort)
    save({ ...(model && { model }), ...(kept && { effort: kept }) })
  }
  const typedModelError =
    typedModel?.trim() && !isValidModelName(typedModel.trim())
      ? CRON_SAVE_MESSAGES.model
      : undefined
  const commitTypedModel = (): void => {
    if (otherDraft === null || typedModelError) return
    withModel(otherDraft.trim() || undefined)
  }

  const summary = pick
    ? [
        BACKEND_LABEL[pick.backend],
        pick.model && modelLabel(row, backend, pick.model),
        pick.effort && effortLabel(pick.effort)
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Default'
  const Chevron = open ? IconChevronUp : IconChevronDown

  return (
    <>
      <div className="set-row">
        <div className="set-lab">
          <b>{title}</b>
          <small>{does}</small>
        </div>
        <button
          className="mini"
          aria-expanded={open}
          aria-label={`${title}: ${summary}`}
          onClick={() => setOpen(!open)}
        >
          {summary}
          <Chevron size={14} />
        </button>
      </div>
      {open && (
        <div className="set-row child">
          <div className="fgrid assist-pick">
            <span className="flabel">Runs on</span>
            <div className="fcol">
              <div>
                <AgentSelect
                  value={backend}
                  ariaLabel={`${title} runs on`}
                  choice={choice}
                  onPick={(b) => {
                    if (b === backend) return
                    setOtherDraft(null)
                    save({}, b)
                  }}
                />
              </div>
            </div>
            <ModelAndThinking
              models={assistModels(row, backend)}
              model={typedModel !== null ? OTHER_MODEL : (pick?.model ?? '')}
              modelOther={typedModel ?? ''}
              unsetModel="Default"
              onModel={(model) => {
                if (model === OTHER_MODEL) return setOtherDraft(typedModel ?? '')
                setOtherDraft(null)
                withModel(model || undefined)
              }}
              onModelOther={setOtherDraft}
              otherInput={{
                className: 'cb-input',
                onBlur: commitTypedModel,
                onKeyDown: (e) => {
                  if (e.key === 'Enter') commitTypedModel()
                }
              }}
              modelHint={`Default: ${whatDefaultIs(row, backend)}.`}
              modelError={typedModelError}
              efforts={efforts}
              effort={pick?.effort ?? ''}
              unsetEffort="Default"
              onEffort={(effort) =>
                save({ ...(pick?.model && { model: pick.model }), ...(effort && { effort }) })
              }
              effortHint={
                row === 'butler'
                  ? 'How hard it thinks before it answers. A change applies the next time it starts.'
                  : SMALL_JOB_WAIT_HINT
              }
            />
          </div>
        </div>
      )}
    </>
  )
}

export function AssistSection(): JSX.Element {
  const assist = useStore((s) => s.settings.assist)
  const butler = useStore((s) => s.settings.butler)
  const name = butler.name
  const runsOn = useStore((s) => assistRunsOn(s.settings))
  const methods = useStore((s) => s.settings.sessionMethods)
  const update = useSettingsUpdate()
  const setup = useAssistSetup()
  const choice = useAgentChoice(setup)
  const [nameDraft, setNameDraft] = useState(name)
  useEffect(() => setNameDraft(name), [name])

  const commitName = (): void => {
    const next = butlerName(nameDraft)
    setNameDraft(next)
    if (next !== name) update({ butler: renamedButler(butler, next) })
  }

  return (
    <>
      <div className="set-grp">Assist</div>
      <div className="set-row">
        <div className="set-lab">
          <b>Runs on</b>
          {SESSION_BACKENDS.filter((b) => methods.enabled[b] && !setup.usable[b]).map((b) => (
            <small key={b} className="ob-warn">
              {BACKEND_LABEL[b]} · {NO_ACCOUNT_LINE}
            </small>
          ))}
          <small>
            Koloft asks an AI for the jobs below, and {name} runs on it too. Each one uses this
            unless it has a pick of its own. {ASSIST_COST_LINE}
          </small>
        </div>
        <AgentSelect
          value={runsOn}
          ariaLabel="Koloft Assist runs on"
          choice={choice}
          onPick={(b) => update({ assist: { ...assist, backend: b } })}
        />
      </div>
      <div className="set-grp">Small jobs</div>
      {ASSIST_JOBS.map((job) => (
        <AssistRow key={job} row={job} setup={setup} {...JOB_COPY[job]} />
      ))}
      <div className="set-grp">Butler</div>
      <AssistRow
        row="butler"
        title={name}
        does="Your butler, whom you talk to from the top of the sidebar or from Discord."
        setup={setup}
      />
      <div className="set-row stack">
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
