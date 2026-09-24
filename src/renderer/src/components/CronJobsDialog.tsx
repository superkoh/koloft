import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { LuPencil, LuPlay, LuTrash2, LuX } from 'react-icons/lu'
import type {
  BackendId,
  CronJob,
  CronPermission,
  CronSaveInput,
  HistoryLine,
  LiveRun,
  SkillSuggestion
} from '@shared/types'
import { basename } from '@shared/preview'
import { cronBackend, slugOf } from '@shared/cronNames'
import { hostOf } from '@shared/remoteKey'
import {
  BACKEND_LABEL,
  capabilitiesFor,
  effectiveBackend,
  SESSION_BACKENDS
} from '@shared/sessionBackend'
import { describeSchedule, describeWhen, nextRun } from '@shared/schedule'
import {
  emptyFields,
  fieldsToSchedule,
  histEnd,
  histText,
  histWhen,
  scheduleToFields,
  suggest,
  validate,
  type JobFields,
  type WhenKind
} from '../cronForm'
import { isComposing } from '../keys'
import { useStore } from '../store'
import { mixesBackends } from '../sessionRows'
import { Switch } from './settings/Switch'

const DAY_CHIPS: { d: number; label: string }[] = [
  { d: 1, label: 'Mon' },
  { d: 2, label: 'Tue' },
  { d: 3, label: 'Wed' },
  { d: 4, label: 'Thu' },
  { d: 5, label: 'Fri' },
  { d: 6, label: 'Sat' },
  { d: 0, label: 'Sun' }
]

const WHEN_CHIPS: { kind: WhenKind; label: string }[] = [
  { kind: 'daily', label: 'Every day' },
  { kind: 'weekly', label: 'Pick days' },
  { kind: 'every', label: 'Repeat every…' }
]

const MODEL_CHIPS: { value: JobFields['model']; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'other', label: 'Other…' }
]

const MODEL_CHIPS_OF: Record<BackendId, typeof MODEL_CHIPS> = {
  claude: MODEL_CHIPS,
  codex: MODEL_CHIPS.filter((c) => c.value === '' || c.value === 'other')
}

const APP_NAME: Record<BackendId, string> = { claude: 'Claude Code', codex: 'Codex' }

const EFFORT_CHIPS: { value: JobFields['effort']; label: string }[] = [
  { value: '', label: 'Same as usual' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

const PERMISSION_CHIPS: { value: CronPermission; label: string }[] = [
  { value: 'same', label: 'Same as my other sessions' },
  { value: 'acceptEdits', label: 'Let it edit files without asking' },
  { value: 'skipAll', label: 'Never ask' }
]

const taskHint = (label: string): string =>
  `Type the skill's /name, the same as in ${label} — or any message. It cannot start with a dash.`
const MODEL_HINT = 'Default = whatever a new session in this workspace would use.'
const effortHint = (label: string): string =>
  `How hard ${label} thinks before it answers. Same as usual = what your other sessions use.`
const NEVER_ASK_HINT =
  '"Never ask" can change files anywhere on this Mac, not only in the run\'s folder.'
const NO_GIT_NOTE = 'This folder is not a git repo, so the run works in the folder itself.'
// CC§9 CODEX§14
const TRUST_QUESTION: Record<BackendId, string> = {
  claude: 'do you trust this project?',
  codex: 'do you trust the contents of this directory?'
}
const trustHint = (backend: BackendId): string =>
  `${BACKEND_LABEL[backend]} has never been opened in this folder. Start one session here ` +
  `first — a scheduled run would stall on ${BACKEND_LABEL[backend]}'s "${TRUST_QUESTION[backend]}" ` +
  'question and be stopped at the deadline.'

const MANY_RUN_FOLDERS = 10

const LIVE_WORDS: Record<LiveRun['state'], string> = {
  launching: 'starting',
  running: 'working',
  done: 'done — waiting for you'
}
const HIST_WORDS: Record<HistoryLine['state'], string> = {
  closed: 'closed by you',
  ended: 'ended — Koloft quit',
  failed: 'could not start',
  skipped: 'skipped',
  missed: 'missed'
}

function histDot(h: HistoryLine): string {
  if (h.state === 'skipped') return 'dot skip'
  if (h.state === 'failed') return 'dot bad'
  return 'dot'
}

export function CronJobsDialog({
  wsPath,
  initialJobId,
  onClose
}: {
  wsPath: string
  initialJobId?: string
  onClose: () => void
}): JSX.Element {
  const cron = useStore((s) => s.cron)
  const settings = useStore((s) => s.settings)
  const isGit = useStore(
    (s) => s.workspaceRows.find((w) => w.workspace.path === wsPath)?.workspace.isGit === true
  )

  const jobs = cron.jobs
    .filter((j) => j.workspacePath === wsPath)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)

  const backends = SESSION_BACKENDS.filter(
    (b) =>
      settings.sessionMethods.enabled[b] &&
      capabilitiesFor(b, hostOf(wsPath)).scheduledTasks === true
  )
  const defaultBackend = effectiveBackend(settings.sessionMethods, new Set(backends))
  const mixed = mixesBackends(jobs.map((j) => ({ backendId: cronBackend(j) })))

  const [selectedId, setSelectedId] = useState<string | null>(initialJobId ?? null)
  const selected = jobs.find((j) => j.id === selectedId) ?? jobs[0]
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [form, setForm] = useState<{ mode: 'new' } | { mode: 'edit'; id: string } | null>(null)
  const [fields, setFields] = useState<JobFields>(emptyFields())
  const [touched, setTouched] = useState(false)
  const [serverErrors, setServerErrors] = useState<string[]>([])
  const [skills, setSkills] = useState<SkillSuggestion[]>([])
  const [trusted, setTrusted] = useState<boolean | null>(null)
  const [hot, setHot] = useState(0)
  const [focusKey, setFocusKey] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const stateWhenAsked = useStore.getState().cron
    void window.api.cron
      .list()
      .then((s) => {
        if (useStore.getState().cron === stateWhenAsked) useStore.getState().setCron(s)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!form) return
    let live = true
    void window.api.cron
      .skills(wsPath)
      .then((s) => {
        if (live) setSkills(s)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [form, wsPath])

  useEffect(() => {
    let live = true
    setTrusted(null)
    void window.api.cron
      .trusted(wsPath, fields.backend)
      .then((t) => {
        if (live) setTrusted(t)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [wsPath, fields.backend])

  useEffect(() => {
    if (form) nameRef.current?.focus()
  }, [form])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (form) closeForm()
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const closeForm = (): void => {
    setForm(null)
    setTouched(false)
    setServerErrors([])
  }

  const edit = (job: CronJob): void => {
    const f = emptyFields(cronBackend(job))
    setFields({
      ...f,
      ...scheduleToFields(job.schedule),
      name: job.name,
      task: job.task,
      model: !job.model
        ? ''
        : job.model === 'fable' || job.model === 'opus' || job.model === 'sonnet'
          ? job.model
          : 'other',
      modelOther: job.model && !['fable', 'opus', 'sonnet'].includes(job.model) ? job.model : '',
      effort: job.effort ?? '',
      permission: job.permission
    })
    setTouched(false)
    setServerErrors([])
    setSelectedId(job.id)
    setForm({ mode: 'edit', id: job.id })
  }

  const newJob = (): void => {
    setFields(emptyFields(defaultBackend))
    setTouched(false)
    setServerErrors([])
    setForm({ mode: 'new' })
  }

  const patch = (p: Partial<JobFields>): void => {
    setTouched(true)
    setServerErrors([])
    setFields((f) => ({ ...f, ...p }))
  }

  const result = validate(fields)
  const errors = result.ok ? {} : result.errors
  const err = (k: keyof JobFields): string | undefined => (touched ? errors[k] : undefined)

  const save = async (): Promise<void> => {
    if (!result.ok || !form) return
    const editing = form.mode === 'edit' ? jobs.find((j) => j.id === form.id) : undefined
    const input: CronSaveInput = {
      ...result.input,
      workspacePath: wsPath,
      enabled: editing ? editing.enabled : true
    }
    if (form.mode === 'edit') input.id = form.id
    const r = await window.api.cron.save(input)
    if (r.ok) {
      setSelectedId(r.job.id)
      closeForm()
    } else {
      setServerErrors(r.errors)
    }
  }

  const sugs = suggest(fields.task, skills)
  const pick = (s: SkillSuggestion): void => {
    patch({ task: s.name + ' ' })
    setHot(0)
  }

  const onTaskKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (sugs.length === 0 || isComposing(e)) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setHot((h) => (e.key === 'ArrowDown' ? Math.min(h + 1, sugs.length - 1) : Math.max(h - 1, 0)))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(sugs[Math.min(hot, sugs.length - 1)])
    }
  }

  const inputCls = (key: string): string => 'cb-input' + (focusKey === key ? ' focus' : '')
  const focusProps = (key: string): { onFocus: () => void; onBlur: () => void } => ({
    onFocus: () => setFocusKey(key),
    onBlur: () => setFocusKey((k) => (k === key ? '' : k))
  })

  const liveOf = (id: string): LiveRun | undefined => cron.live.find((l) => l.jobId === id)

  const whenLine = (job: CronJob): string => {
    const words = describeSchedule(job.schedule)
    if (!job.enabled) return `${words} · off`
    return `${words} · next ${describeWhen(nextRun(job.schedule, new Date()), new Date())}`
  }

  const lastLine = (job: CronJob): JSX.Element => {
    const live = liveOf(job.id)
    const h = job.history[0]
    const folders = cron.folders[job.id] ?? 0
    const count = `${folders} run folder${folders === 1 ? '' : 's'} on disk`
    const foldersPart =
      folders === 0 ? null : (
        <>
          {' · '}
          {folders > MANY_RUN_FOLDERS ? <span className="am">{count}</span> : count}
        </>
      )
    if (!live && !h) return <>never run{foldersPart}</>

    const hAt = h ? histEnd(h) : 0
    const useLive = !!live && (!h || live.dueAt >= hAt)
    const dueAt = useLive && live ? live.dueAt : hAt
    const words = useLive && live ? LIVE_WORDS[live.state] : HIST_WORDS[h.state]
    const good = useLive && live?.state === 'done'
    return (
      <>
        {`last run ${describeWhen(new Date(dueAt), new Date())} · `}
        {good ? <span className="g">{words}</span> : words}
        {foldersPart}
      </>
    )
  }

  const renderCard = (job: CronJob): JSX.Element => (
    <div
      className={'job-row' + (job.enabled ? '' : ' off')}
      key={job.id}
      onClick={() => setSelectedId(job.id)}
    >
      <Switch
        checked={job.enabled}
        small
        ariaLabel={`${job.name} on`}
        onChange={(on) => void window.api.cron.setEnabled(job.id, on)}
      />
      <div className="job-main">
        <div className="job-name">{job.name}</div>
        <div className="job-task">
          {[mixed ? BACKEND_LABEL[cronBackend(job)] : '', job.task, job.model, job.effort]
            .filter(Boolean)
            .join(' · ')}
        </div>
        {cron.notes[job.id] && <p className="field-hint bad">{cron.notes[job.id]}</p>}
        <div className="job-when">{whenLine(job)}</div>
        <div className="job-last">{lastLine(job)}</div>
      </div>
      {confirmId === job.id ? (
        <div className="job-acts">
          <span className="field-hint">{`Delete "${job.name}"? Its runs stay in the sidebar.`}</span>
          <button
            className="mini danger"
            onClick={() => {
              setConfirmId(null)
              void window.api.cron.delete(job.id)
            }}
          >
            Delete
          </button>
          <button className="mini" onClick={() => setConfirmId(null)}>
            Keep
          </button>
        </div>
      ) : (
        <div className="job-acts">
          <button className="mini" onClick={() => void window.api.cron.runNow(job.id)}>
            <LuPlay size={11} />
            Run now
          </button>
          <button className="ibtn" aria-label={`Edit ${job.name}`} onClick={() => edit(job)}>
            <LuPencil size={15} />
          </button>
          <button
            className="ibtn danger"
            aria-label={`Delete ${job.name}`}
            onClick={() => setConfirmId(job.id)}
          >
            <LuTrash2 size={15} />
          </button>
        </div>
      )}
    </div>
  )

  const slug = slugOf(fields.name)
  const schedule = fieldsToSchedule(fields)
  const preview = schedule
    ? `${describeSchedule(schedule)} · next ${describeWhen(nextRun(schedule, new Date()), new Date())}`
    : ''

  const label = BACKEND_LABEL[fields.backend]
  const modelChips = MODEL_CHIPS_OF[fields.backend]

  const permissionHint =
    (fields.backend === 'claude' && settings.multiAccount && settings.skipPermissions
      ? 'Today that means: skips all permission checks (your Accounts setting).'
      : `Today that means: ${label} asks before risky steps, like your other sessions.`) +
    ' ' +
    NEVER_ASK_HINT

  const whereItRuns = (): JSX.Element =>
    isGit ? (
      <p className="fnote">
        A new copy of the repo every time —{' '}
        <span className="m">{`.claude/worktrees/${slug}-<date>-<time>`}</span>, branch{' '}
        <span className="m">{`worktree-${slug}-…`}</span>. Your own files are never touched. Each
        run&apos;s folder and branch stay until you remove them (
        <span className="m">git worktree remove</span>). Closing and /exit work exactly as in any
        New worktree session.
      </p>
    ) : (
      <p className="fnote">{NO_GIT_NOTE}</p>
    )

  const renderForm = (): JSX.Element => (
    <div className="fgrid">
      {backends.length > 1 && (
        <>
          <span className="flabel">Runs in</span>
          <div className="fcol">
            <div className="chips">
              {backends.map((b) => (
                <button
                  key={b}
                  className={'chip' + (fields.backend === b ? ' on' : '')}
                  onClick={() =>
                    patch({
                      backend: b,
                      ...(MODEL_CHIPS_OF[b].some((c) => c.value === fields.model)
                        ? {}
                        : { model: '' })
                    })
                  }
                >
                  {BACKEND_LABEL[b]}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      <span className="flabel">Name</span>
      <div className="fcol">
        <div className={inputCls('name')}>
          <input
            ref={nameRef}
            className="cb-field"
            aria-label="Name"
            spellCheck={false}
            autoComplete="off"
            value={fields.name}
            onChange={(e) => patch({ name: e.target.value })}
            {...focusProps('name')}
          />
        </div>
        {err('name') && <p className="field-hint bad">{err('name')}</p>}
      </div>

      <span className="flabel">What to run</span>
      <div className="fcol">
        <div className={inputCls('task')}>
          <textarea
            className="cb-field task"
            aria-label="What to run"
            rows={3}
            spellCheck={false}
            autoComplete="off"
            value={fields.task}
            onChange={(e) => {
              patch({ task: e.target.value })
              setHot(0)
            }}
            onKeyDown={onTaskKey}
            {...focusProps('task')}
          />
        </div>
        {sugs.length > 0 && (
          <div className="wt-list">
            {sugs.map((s, i) => (
              <div
                key={s.name + s.source}
                className={'cb-row' + (i === Math.min(hot, sugs.length - 1) ? ' hot' : '')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
              >
                <span className="wt-name">{s.name}</span>
                <span className="note">{s.description ?? ''}</span>
              </div>
            ))}
          </div>
        )}
        <p className="field-hint">{taskHint(APP_NAME[fields.backend])}</p>
        {err('task') && <p className="field-hint bad">{err('task')}</p>}
      </div>

      <span className="flabel">Where it runs</span>
      <div className="fcol">
        {whereItRuns()}
        {trusted === false && <p className="field-hint warn">{trustHint(fields.backend)}</p>}
      </div>

      <span className="flabel">When</span>
      <div className="fcol">
        <div className="chips">
          {WHEN_CHIPS.map((c) => (
            <button
              key={c.kind}
              className={'chip' + (fields.whenKind === c.kind ? ' on' : '')}
              onClick={() => patch({ whenKind: c.kind })}
            >
              {c.label}
            </button>
          ))}
        </div>
        {fields.whenKind === 'weekly' && (
          <div className="chips" style={{ paddingTop: 2 }}>
            {DAY_CHIPS.map((c) => (
              <button
                key={c.d}
                className={'chip day' + (fields.days.includes(c.d) ? ' on' : '')}
                onClick={() =>
                  patch({
                    days: fields.days.includes(c.d)
                      ? fields.days.filter((d) => d !== c.d)
                      : [...fields.days, c.d]
                  })
                }
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        {fields.whenKind === 'every' ? (
          <div className="inline">
            <div className={inputCls('n')}>
              <input
                className="cb-field"
                type="number"
                aria-label="Repeat every"
                min={1}
                value={Number.isNaN(fields.n) ? '' : String(fields.n)}
                onChange={(e) =>
                  patch({ n: e.target.value === '' ? Number.NaN : Number(e.target.value) })
                }
                {...focusProps('n')}
              />
            </div>
            <select
              aria-label="unit"
              value={fields.unit}
              onChange={(e) => patch({ unit: e.target.value as JobFields['unit'] })}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
            {preview && <span className="field-hint">{preview}</span>}
          </div>
        ) : (
          <div className="inline">
            <span className="field-hint">at</span>
            <div className={inputCls('at') + ' time'}>
              <input
                className="cb-field"
                type="time"
                aria-label="at"
                value={fields.at}
                onChange={(e) => patch({ at: e.target.value })}
                {...focusProps('at')}
              />
            </div>
            {preview && <span className="field-hint">{preview}</span>}
          </div>
        )}
        {err('days') && <p className="field-hint bad">{err('days')}</p>}
        {err('at') && <p className="field-hint bad">{err('at')}</p>}
        {err('n') && <p className="field-hint bad">{err('n')}</p>}
      </div>

      <span className="flabel">Model</span>
      <div className="fcol">
        <div className="chips">
          {modelChips.map((c) => (
            <button
              key={c.label}
              className={'chip' + (fields.model === c.value ? ' on' : '')}
              onClick={() => patch({ model: c.value })}
            >
              {c.label}
            </button>
          ))}
        </div>
        {fields.model === 'other' && (
          <div className={inputCls('modelOther')}>
            <input
              className="cb-field"
              aria-label="Model name"
              spellCheck={false}
              autoComplete="off"
              value={fields.modelOther}
              onChange={(e) => patch({ modelOther: e.target.value })}
              {...focusProps('modelOther')}
            />
          </div>
        )}
        <p className="field-hint">{MODEL_HINT}</p>
        {err('modelOther') && <p className="field-hint bad">{err('modelOther')}</p>}
      </div>

      <span className="flabel">Thinking</span>
      <div className="fcol">
        <div className="chips">
          {EFFORT_CHIPS.map((c) => (
            <button
              key={c.label}
              className={'chip' + (fields.effort === c.value ? ' on' : '')}
              onClick={() => patch({ effort: c.value })}
            >
              {c.label}
            </button>
          ))}
        </div>
        <p className="field-hint">{effortHint(label)}</p>
      </div>

      <span className="flabel">Permissions</span>
      <div className="fcol">
        <div className="chips">
          {PERMISSION_CHIPS.map((c) => (
            <button
              key={c.value}
              className={'chip' + (fields.permission === c.value ? ' on' : '')}
              onClick={() => patch({ permission: c.value })}
            >
              {c.label}
            </button>
          ))}
        </div>
        <p className="field-hint">{permissionHint}</p>
      </div>

      {serverErrors.length > 0 && (
        <>
          <span className="flabel" />
          <div className="fcol">
            {serverErrors.map((m) => (
              <p className="field-hint bad" key={m}>
                {m}
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  )

  const renderHistory = (): JSX.Element | null => {
    if (!selected) return null
    const live = liveOf(selected.id)
    return (
      <div className="hist">
        <span className="flabel">{`History · ${selected.name}`}</span>
        <div className="hist-list">
          {live?.state === 'done' && (
            <div className="hist-row">
              <span className="hist-when">{describeWhen(new Date(live.dueAt), new Date())}</span>
              <span className="hist-state">
                <span className="dot ok" />
                Done — waiting for you
              </span>
              {live.worktree && <span className="hist-wt">{` · ${live.worktree}`}</span>}
            </div>
          )}
          {selected.history.map((h, i) => (
            <div className="hist-row" key={`${h.dueAt}-${i}`}>
              <span className="hist-when">{histWhen(h, new Date())}</span>
              <span className="hist-state">
                <span className={histDot(h)} />
                {histText(h)}
              </span>
              {h.worktree && <span className="hist-wt">{` · ${h.worktree}`}</span>}
            </div>
          ))}
        </div>
      </div>
    )
  }

  const header =
    `Scheduled jobs · ${basename(wsPath)}` +
    (form ? (form.mode === 'new' ? ' · new' : ' · edit') : '')

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal cronjobs"
        role="dialog"
        aria-label="Scheduled jobs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>{header}</span>
          <span className="modal-close" onClick={onClose} aria-label="Close">
            <LuX size={16} />
          </span>
        </div>
        <div className="modal-body">
          {form ? (
            renderForm()
          ) : (
            <>
              {jobs.length > 0 && <div className="job-list">{jobs.map(renderCard)}</div>}
              <button className="mini" onClick={newJob}>
                ＋ New job
              </button>
              {renderHistory()}
            </>
          )}
        </div>
        {form && (
          <div className="modal-foot">
            {form.mode === 'edit' && (
              <button
                className="mini danger"
                onClick={() => {
                  const id = form.id
                  closeForm()
                  void window.api.cron.delete(id)
                }}
              >
                Delete job
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button className="mini" onClick={closeForm}>
              Cancel
            </button>
            <button className="btn-primary" disabled={!result.ok} onClick={() => void save()}>
              Save job
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
