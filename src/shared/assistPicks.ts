import {
  ASSIST_JOBS,
  isCronEffort,
  type AccountMeta,
  type AssistPick,
  type AssistRowId,
  type AssistSetting,
  type BackendId,
  type CronEffort,
  type SessionMethods
} from './types'
import { ACCOUNT_KINDS_OF, usableAccounts } from './accountUsage'
import { effortsFor, NAMED_MODELS, takenEffort, type NamedModel } from './cronModels'
import { isValidModelName } from './cronNames'
import { backendIdOf, byBackend, SESSION_BACKENDS } from './sessionBackend'

export const ASSIST_ROWS: readonly AssistRowId[] = [...ASSIST_JOBS, 'butler']

export interface ModelAndEffort {
  model?: string
  effort?: CronEffort
}

// CC§9 CODEX§15
export const EVERY_ACCOUNT_TAKES: Record<BackendId, ModelAndEffort> = {
  claude: { model: 'haiku' },
  codex: { model: 'gpt-6-luna' },
  muse: {},
  agy: {}
}

// CC§9 CODEX§15 MUSE§1 AGY§21
const SMALL_AND_QUICK: Record<BackendId, ModelAndEffort> = {
  claude: EVERY_ACCOUNT_TAKES.claude,
  codex: { ...EVERY_ACCOUNT_TAKES.codex, effort: 'low' },
  muse: { effort: 'low' },
  agy: { model: 'gemini-3.8-flash', effort: 'low' }
}

// CC§9 CODEX§15 MUSE§1 AGY§21
export const ASSIST_DEFAULTS: Record<AssistRowId, Record<BackendId, ModelAndEffort>> = {
  title: SMALL_AND_QUICK,
  handover: SMALL_AND_QUICK,
  turn: {
    claude: { model: 'haiku' },
    codex: { model: 'gpt-6.1-sol', effort: 'medium' },
    muse: { effort: 'medium' },
    agy: { model: 'gemini-4-argon', effort: 'medium' }
  },
  docs: SMALL_AND_QUICK,
  route: {
    claude: { model: 'sonnet', effort: 'low' },
    codex: { model: 'gpt-6.1-sol', effort: 'low' },
    muse: { effort: 'low' },
    agy: { model: 'gemini-3.8-flash', effort: 'low' }
  },
  butler: byBackend(() => ({}))
}

const HAIKU: NamedModel = { id: 'haiku', label: 'Haiku' }

export function assistModels(row: AssistRowId, backend: BackendId): NamedModel[] {
  return row !== 'butler' && backend === 'claude'
    ? [HAIKU, ...NAMED_MODELS.claude]
    : NAMED_MODELS[backend]
}

// CC§9 CODEX§15
const EFFORT_A_SMALL_JOB_OUTLASTS: CronEffort = 'max'

export function assistEfforts(
  row: AssistRowId,
  backend: BackendId,
  model: string | undefined
): readonly CronEffort[] {
  const taken = effortsFor(backend, model)
  return row === 'butler' ? taken : taken.filter((e) => e !== EFFORT_A_SMALL_JOB_OUTLASTS)
}

type Resolved = {
  assist: AssistSetting
  sessionMethods: SessionMethods
  accounts: readonly Pick<AccountMeta, 'kind' | 'enabled' | 'status' | 'addedAt'>[]
}

function backendOfAccount(a: Pick<AccountMeta, 'kind'>): BackendId {
  return SESSION_BACKENDS.find((b) => ACCOUNT_KINDS_OF[b].includes(a.kind))!
}

export function backendsByAccountAge(
  s: Pick<Resolved, 'accounts' | 'sessionMethods'>
): BackendId[] {
  const usable = usableAccounts(
    s.accounts,
    SESSION_BACKENDS.flatMap((b) => ACCOUNT_KINDS_OF[b])
  )
  const oldestFirst = usable
    .map((a, at) => ({ a, at }))
    .sort((x, y) => x.a.addedAt - y.a.addedAt || x.at - y.at)
  return [...new Set(oldestFirst.map(({ a }) => backendOfAccount(a)))].filter(
    (b) => s.sessionMethods.enabled[b]
  )
}

export function assistRunsOn(s: Resolved): BackendId {
  return s.assist.backend ?? backendsByAccountAge(s)[0] ?? s.sessionMethods.defaultBackend
}

export function assistRowBackend(row: AssistRowId, s: Resolved): BackendId {
  return s.assist.rows?.[row]?.backend ?? assistRunsOn(s)
}

export function assistBackendsFor(row: AssistRowId, s: Resolved): BackendId[] {
  return [
    ...new Set([
      assistRowBackend(row, s),
      assistRunsOn(s),
      ...backendsByAccountAge(s),
      ...SESSION_BACKENDS
    ])
  ]
}

export interface AssistLaunch extends ModelAndEffort {
  modelFromTheTable: boolean
  effortFromTheTable: boolean
}

export function assistLaunchOn(row: AssistRowId, backend: BackendId, s: Resolved): AssistLaunch {
  const table = ASSIST_DEFAULTS[row][backend]
  const pick = s.assist.rows?.[row]
  const own = pick?.backend === backend ? pick : undefined
  const model = own?.model ?? table.model
  const effort = takenEffort(backend, model, own?.effort ?? table.effort)
  return {
    ...(model !== undefined && { model }),
    ...(effort !== undefined && { effort }),
    modelFromTheTable: own?.model === undefined,
    effortFromTheTable: own?.effort === undefined
  }
}

export function withAssistPick(
  assist: AssistSetting,
  row: AssistRowId,
  pick: AssistPick | undefined
): AssistSetting {
  const { [row]: _former, ...others } = assist.rows ?? {}
  const kept = sanitizePick(row, pick)
  const rows = kept ? { ...others, [row]: kept } : others
  const { rows: _rows, ...rest } = assist
  return Object.keys(rows).length ? { ...rest, rows } : rest
}

function sanitizePick(row: AssistRowId, raw: unknown): AssistPick | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { backend, model, effort } = raw as Record<string, unknown>
  const on = backendIdOf(backend)
  if (!on) return undefined
  const pick: AssistPick = { backend: on }
  if (typeof model === 'string' && isValidModelName(model)) pick.model = model
  if (isCronEffort(effort) && (row === 'butler' || effort !== EFFORT_A_SMALL_JOB_OUTLASTS))
    pick.effort = effort
  return pick
}

export function sanitizeAssist(raw: unknown): AssistSetting {
  if (!raw || typeof raw !== 'object') return {}
  const doc = raw as Record<string, unknown>
  const assist: AssistSetting = {}
  const backend = backendIdOf(doc.backend)
  if (backend) assist.backend = backend
  const rows: NonNullable<AssistSetting['rows']> = {}
  if (doc.rows && typeof doc.rows === 'object')
    for (const row of ASSIST_ROWS) {
      const pick = sanitizePick(row, (doc.rows as Record<string, unknown>)[row])
      if (pick) rows[row] = pick
    }
  if (Object.keys(rows).length) assist.rows = rows
  return assist
}

export function assistOnMethodsThatAreOn(
  assist: AssistSetting,
  methods: SessionMethods
): AssistSetting {
  const off = (b: BackendId): boolean => !methods.enabled[b]
  const rows = Object.fromEntries(
    Object.entries(assist.rows ?? {}).filter(([, pick]) => !off(pick.backend))
  )
  return {
    ...(assist.backend && {
      backend: off(assist.backend) ? methods.defaultBackend : assist.backend
    }),
    ...(Object.keys(rows).length > 0 && { rows })
  }
}
