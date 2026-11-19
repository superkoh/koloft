import { useState, type JSX } from 'react'
import { assistJobDefaults } from '@core/assistJobs'
import type { PluginAssistJob, PluginManifest } from '@core/plugin'
import { PLUGINS } from '@plugins/list'
import { assistEfforts, assistModels, assistRunsOn, withAssistPick } from '@shared/assistPicks'
import { CRON_SAVE_MESSAGES } from '@shared/cronMessages'
import { takenEffort } from '@shared/cronModels'
import { isValidModelName } from '@shared/cronNames'
import { BACKEND_LABEL, SESSION_BACKENDS } from '@shared/sessionBackend'
import { PLUGINS_PANE_NAME } from '@shared/settingsPanes'
import type { AssistPick, AssistRowId, BackendId } from '@shared/types'
import { IconChevronDown, IconChevronRight, IconChevronUp } from '../../icons'
import { assistInputs } from '../../assistInputs'
import { useStore } from '../../store'
import { useAssistSetup, type AssistSetupState } from '../../useAssistSetup'
import { ASSIST_COST_LINE } from '../AssistSetup'
import { effortLabel, ModelAndThinking, OTHER_MODEL } from '../ModelAndThinking'
import { AgentSelect } from '../SessionLaunchButtons'
import { pluginPane, useSettingsGo } from './settingsNav'
import { useSettingsUpdate } from './useSettingsUpdate'
import '../../cronJobs.css'

const NO_ACCOUNT_LINE = 'no account — add one in Settings ▸ Accounts'

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
  const { model, effort } = assistJobDefaults(row, backend)
  const parts = [
    model && modelLabel(row, backend, model),
    effort && `${effortLabel(effort)} thinking`
  ].filter(Boolean)
  const own = `${BACKEND_LABEL[backend]}’s own`
  if (!parts.length) return `${own} model and thinking`
  return parts.join(', ') + (model ? '' : `, on ${own} model`)
}

function useAssistSummary(row: AssistRowId): string {
  const pick = useStore((s) => s.settings.assist.rows?.[row])
  if (!pick) return 'Default'
  return [
    BACKEND_LABEL[pick.backend],
    pick.model && modelLabel(row, pick.backend, pick.model),
    pick.effort && effortLabel(pick.effort)
  ]
    .filter(Boolean)
    .join(' · ')
}

export function AssistRow({
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
  const runsOn = useStore((s) => assistRunsOn(assistInputs(s)))
  const update = useSettingsUpdate()
  const choice = useAgentChoice(setup)
  const [open, setOpen] = useState(false)
  const [otherDraft, setOtherDraft] = useState<string | null>(null)

  const pick = assist.rows?.[row]
  const backend = pick?.backend ?? runsOn
  const named = pick?.model && assistModels(row, backend).some((m) => m.id === pick.model)
  const typedModel = otherDraft ?? (pick?.model && !named ? pick.model : null)
  const efforts = assistEfforts(row, backend, pick?.model ?? assistJobDefaults(row, backend).model)

  const save = (next: Omit<AssistPick, 'backend'>, on = backend): void => {
    const nothingOfItsOwn = on === runsOn && !next.model && !next.effort
    update({
      assist: withAssistPick(assist, row, nothingOfItsOwn ? undefined : { ...next, backend: on })
    })
  }
  const withModel = (model: string | undefined): void => {
    const kept = takenEffort(backend, model ?? assistJobDefaults(row, backend).model, pick?.effort)
    save({ ...(model && { model }), ...(kept && { effort: kept }) })
  }
  const typedModelError =
    typedModel?.trim() && !isValidModelName(typedModel.trim())
      ? CRON_SAVE_MESSAGES.model
      : undefined
  const commitTypedModel = (): void => {
    if (otherDraft === null || typedModelError) return
    withModel(otherDraft.trim() || undefined)
    setOtherDraft(null)
  }
  const modelShown =
    otherDraft !== null && !typedModelError ? otherDraft.trim() || undefined : pick?.model

  const summary = useAssistSummary(row)
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
          <div className="fgrid">
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
                save({ ...(modelShown && { model: modelShown }), ...(effort && { effort }) })
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

function JobOverviewRow({ job, plugin }: { job: PluginAssistJob; plugin: PluginManifest }) {
  const summary = useAssistSummary(job.id)
  const go = useSettingsGo()
  return (
    <div className="set-row">
      <div className="set-lab">
        <b>{job.name}</b>
        <small>{job.does}</small>
        <small>
          Set on {PLUGINS_PANE_NAME} ▸ {plugin.name}.
        </small>
      </div>
      <button
        className="mini"
        title={`Open ${PLUGINS_PANE_NAME} ▸ ${plugin.name}`}
        aria-label={`${job.name}: ${summary}`}
        onClick={() => go(pluginPane(plugin.id))}
      >
        {summary}
        <IconChevronRight size={14} />
      </button>
    </div>
  )
}

const JOBS_BY_PLUGIN = PLUGINS.flatMap((plugin) =>
  (plugin.assistJobs ?? []).map((job) => ({ job, plugin }))
)

export function AssistSection(): JSX.Element {
  const assist = useStore((s) => s.settings.assist)
  const name = useStore((s) => s.settings.butler.name)
  const runsOn = useStore((s) => assistRunsOn(assistInputs(s)))
  const methods = useStore((s) => s.settings.sessionMethods)
  const update = useSettingsUpdate()
  const setup = useAssistSetup()
  const choice = useAgentChoice(setup)

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
      {JOBS_BY_PLUGIN.map(({ job, plugin }) => (
        <JobOverviewRow key={job.id} job={job} plugin={plugin} />
      ))}
    </>
  )
}
