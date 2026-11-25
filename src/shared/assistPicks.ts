import { ASSIST_JOBS, assistJobDefaults } from '@core/assistJobs'
import type { ModelAndEffort } from '@core/assistModels'
import {
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
import { backendIdOf, SESSION_BACKENDS } from './sessionBackend'
import { capitalized } from './sessionDefaults'
import { agentManifest } from '@core/agent/registry'

export const ASSIST_ROWS: readonly AssistRowId[] = [...ASSIST_JOBS.map((j) => j.id), 'butler']

function smallJobModelsNotNamed(backend: BackendId): NamedModel[] {
  const named = new Set(NAMED_MODELS[backend].map((m) => m.id))
  const ids = Object.values(agentManifest(backend).smallJobModels).flatMap((m) =>
    m.model && !named.has(m.model) ? [m.model] : []
  )
  return [...new Set(ids)].map((id) => ({ id, label: capitalized(id) }))
}

export function assistModels(row: AssistRowId, backend: BackendId): NamedModel[] {
  return row !== 'butler'
    ? [...smallJobModelsNotNamed(backend), ...NAMED_MODELS[backend]]
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

export type AssistInputs = Resolved

type Resolved = {
  assist: AssistSetting
  sessionMethods: SessionMethods
  accounts: readonly Pick<AccountMeta, 'kind' | 'enabled' | 'status' | 'addedAt'>[]
}

function backendOfAccount(a: Pick<AccountMeta, 'kind'>): BackendId {
  return SESSION_BACKENDS.find((b) => ACCOUNT_KINDS_OF[b].includes(a.kind))!
}

let lastByAge:
  { accounts: Resolved['accounts']; methods: SessionMethods; order: BackendId[] } | undefined

export function backendsByAccountAge(
  s: Pick<Resolved, 'accounts' | 'sessionMethods'>
): BackendId[] {
  if (lastByAge?.accounts === s.accounts && lastByAge.methods === s.sessionMethods)
    return lastByAge.order
  const order = sortedByAccountAge(s)
  lastByAge = { accounts: s.accounts, methods: s.sessionMethods, order }
  return order
}

function sortedByAccountAge(s: Pick<Resolved, 'accounts' | 'sessionMethods'>): BackendId[] {
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
  const table = assistJobDefaults(row, backend)
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
    Object.entries(assist.rows ?? {}).filter(([, pick]) => pick && !off(pick.backend))
  )
  return {
    ...(assist.backend && {
      backend: off(assist.backend) ? methods.defaultBackend : assist.backend
    }),
    ...(Object.keys(rows).length > 0 && { rows })
  }
}
