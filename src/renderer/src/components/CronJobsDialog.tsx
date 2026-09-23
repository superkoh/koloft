import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { LuPencil, LuPlay, LuTrash2, LuX } from 'react-icons/lu'
import type {
  CronJob,
  CronPermission,
  CronSaveInput,
  HistoryLine,
  LiveRun,
  SkillSuggestion
} from '@shared/types'
import { basename } from '@shared/preview'
import { slugOf } from '@shared/cronNames'
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
import { Switch } from './settings/Switch'

/**
 * The one door to a workspace's scheduled jobs. It shows the saved rules as
 * cards, the form that writes one, and the runs each rule has had.
 *
 * Nothing here owns anything: main holds the store, the clock and every launch, and
 * this dialog only asks and re-paints what main pushes back. That is why a card reads
 * its live run out of `cron.live` rather than remembering a save it just made —
 * two windows of the same app would otherwise disagree.
 */

/** Mon first: the chips read the way a week is written, while the stored numbers stay
 *  JavaScript's (0 = Sunday). */
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

const TASK_HINT =
  "Type the skill's /name, the same as in Claude Code — or any message. It cannot start with a dash."
const MODEL_HINT = 'Default = whatever a new session in this workspace would use.'
const EFFORT_HINT =
  'How hard Claude thinks before it answers. Same as usual = what your other sessions use.'
const NEVER_ASK_HINT =
  '"Never ask" can change files anywhere on this Mac, not only in the run\'s folder.'
const NO_GIT_NOTE = 'This folder is not a git repo, so the run works in the folder itself.'
/** A folder claude has never run in asks "do you trust this project?" first, and nothing
 *  automated can answer it — the run would sit there until the start deadline killed it
 *  (docs/claude-code-contract.md §9). Saying so is all Koloft does: it is a hint, not a
 *  refusal, because one session opened by hand here fixes it for good. */
const TRUST_HINT =
  'Claude has never been opened in this folder. Start one session here first — a scheduled ' +
  'run would stall on Claude\'s "do you trust this project?" question and be stopped at ' +
  'the deadline.'

/** The card's last line, in the words §7.3 fixes. A run that is still open says what
 *  it is doing; a finished one says how it ended. */
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

/** Green for a run that is waiting for a person, amber for a due that was let go,
 *  red for one that never started; everything else is a plain full stop. */
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
  /** the card to open on — the sidebar's forecast row names the job it just said would
   *  run next. Absent (the menu's door) keeps the old rule: the oldest card. */
  initialJobId?: string
  onClose: () => void
}): JSX.Element {
  const cron = useStore((s) => s.cron)
  const settings = useStore((s) => s.settings)
  // git or not is already a fact the sidebar rows carry — the dialog reads the same
  // one rather than asking main a second question about the same folder
  const isGit = useStore(
    (s) => s.workspaceRows.find((w) => w.workspace.path === wsPath)?.workspace.isGit === true
  )

  const jobs = cron.jobs
    .filter((j) => j.workspacePath === wsPath)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)

  /** which card's history is on screen; falls back to the first card */
  const [selectedId, setSelectedId] = useState<string | null>(initialJobId ?? null)
  const selected = jobs.find((j) => j.id === selectedId) ?? jobs[0]
  /** the card whose delete is waiting for a yes */
  const [confirmId, setConfirmId] = useState<string | null>(null)
  /** the open form: a brand-new job, the id of the one being edited, or nothing */
  const [form, setForm] = useState<{ mode: 'new' } | { mode: 'edit'; id: string } | null>(null)
  const [fields, setFields] = useState<JobFields>(emptyFields())
  /** no red text on a form nobody has touched yet — the first keystroke turns it on */
  const [touched, setTouched] = useState(false)
  /** what main said no to, when it refused a save the form thought was fine */
  const [serverErrors, setServerErrors] = useState<string[]>([])
  const [skills, setSkills] = useState<SkillSuggestion[]>([])
  /** null until main has answered; only `false` puts the warning up, so a slow answer
   *  never flashes a warning at a folder that is fine */
  const [trusted, setTrusted] = useState<boolean | null>(null)
  /** which suggestion the keyboard is on */
  const [hot, setHot] = useState(0)
  /** which input wears the focus ring */
  const [focusKey, setFocusKey] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  // Opening the dialog is a question, so ask it. Main only pushes when something it
  // owns changes, and the run folders on disk are not that: a person can delete eight
  // of them behind Koloft's back, and the count would stay wrong until the next fire.
  useEffect(() => {
    // a push that lands while the answer is in flight is the newer of the two, so the
    // answer is dropped: the state object main pushed replaces the one asked about
    const asked = useStore.getState().cron
    void window.api.cron
      .list()
      .then((s) => {
        if (useStore.getState().cron === asked) useStore.getState().setCron(s)
      })
      .catch(() => {})
  }, [])

  // one read per open form: a skill added while the form is up stays absent, the same
  // snapshot rule the worktree dialog's list follows
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

  // one question per open, like the skills list: a person who answers claude's trust
  // question while this dialog is up sees the hint go on their next visit, and that is
  // soon enough for a warning that only ever says "do this first"
  useEffect(() => {
    let live = true
    void window.api.cron
      .trusted(wsPath)
      .then((t) => {
        if (live) setTrusted(t)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [wsPath])

  useEffect(() => {
    if (form) nameRef.current?.focus()
  }, [form])

  // Esc peels one layer per press, outermost last (the ladder `escPeel` states for
  // the other dialogs): the form first, then the dialog itself.
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
    const f = emptyFields()
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
    setFields(emptyFields())
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
      // History follows the job you just wrote — after an edit, its runs are what you
      // came to look at. A dialog nobody has clicked in still falls back to the first
      // card, which is what a fresh open shows.
      setSelectedId(r.job.id)
      closeForm()
    } else {
      setServerErrors(r.errors)
    }
  }

  const sugs = suggest(fields.task, skills)
  const pick = (s: SkillSuggestion): void => {
    // the trailing space is what lets the next word be typed straight away — and it
    // is also what closes the list, since no skill name starts with "<name> "
    patch({ task: s.name + ' ' })
    setHot(0)
  }

  // Enter never saves the form — only the Save button does, so a half-filled form
  // cannot go off by accident. With the skill list open, Enter picks; otherwise it is
  // the textarea's own newline.
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

  // ── the cards ───────────────────────────────────────────────────────────────

  const liveOf = (id: string): LiveRun | undefined => cron.live.find((l) => l.jobId === id)

  const whenLine = (job: CronJob): string => {
    const words = describeSchedule(job.schedule)
    if (!job.enabled) return `${words} · off`
    return `${words} · next ${describeWhen(nextRun(job.schedule, new Date()), new Date())}`
  }

  const lastLine = (job: CronJob): JSX.Element => {
    const live = liveOf(job.id)
    const h = job.history[0]
    // absent key = not a git workspace, so there are no run folders to count; zero of
    // them is said by saying nothing, which is also what keeps a fresh job's line at
    // the plain "never run"
    const folders = cron.folders[job.id] ?? 0
    const count = `${folders} run folder${folders === 1 ? '' : 's'} on disk`
    const foldersPart =
      folders === 0 ? null : (
        <>
          {' · '}
          {folders > 10 ? <span className="am">{count}</span> : count}
        </>
      )
    if (!live && !h) return <>never run{foldersPart}</>

    // the live run is the newest one there is unless a history line somehow outdates
    // it; comparing the due minutes keeps that honest without a special case. A folded
    // row covers a stretch, and "last run" means its NEWEST end — a nap of 85 missed
    // dues must not report the minute the nap began.
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
          {[job.task, job.model, job.effort].filter(Boolean).join(' · ')}
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

  // ── the form ────────────────────────────────────────────────────────────────

  const slug = slugOf(fields.name)
  const schedule = fieldsToSchedule(fields)
  const preview = schedule
    ? `${describeSchedule(schedule)} · next ${describeWhen(nextRun(schedule, new Date()), new Date())}`
    : ''

  const permissionHint =
    (settings.multiAccount && settings.skipPermissions
      ? 'Today that means: skips all permission checks (your Accounts setting).'
      : 'Today that means: Claude asks before risky steps, like your other sessions.') +
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
                // the field must keep the keyboard: a blur would take it away from
                // the only thing that types the task
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
              >
                <span className="wt-name">{s.name}</span>
                <span className="note">{s.description ?? ''}</span>
              </div>
            ))}
          </div>
        )}
        <p className="field-hint">{TASK_HINT}</p>
        {err('task') && <p className="field-hint bad">{err('task')}</p>}
      </div>

      <span className="flabel">Where it runs</span>
      <div className="fcol">
        {whereItRuns()}
        {trusted === false && <p className="field-hint warn">{TRUST_HINT}</p>}
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
          {MODEL_CHIPS.map((c) => (
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
        <p className="field-hint">{EFFORT_HINT}</p>
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

  // ── history ─────────────────────────────────────────────────────────────────

  const renderHistory = (): JSX.Element | null => {
    if (!selected) return null
    const live = liveOf(selected.id)
    return (
      <div className="hist">
        <span className="flabel">{`History · ${selected.name}`}</span>
        <div className="hist-list">
          {/* a run whose turn has ended is a result already, even though nothing has
              been written down yet — it belongs at the top until it is closed */}
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

  // ── the dialog ──────────────────────────────────────────────────────────────

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
