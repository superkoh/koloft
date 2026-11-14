import { CRON_EFFORTS, isCronEffort, type BackendId, type CronEffort, type OwnPick } from './types'
import { BACKEND_LABEL } from './sessionBackend'
import { NAMED_MODELS, effortsFor, takenEffort } from './cronModels'
import { isValidModelName } from './cronNames'
import { isRecord } from './workbenchState'

export interface Pick {
  model?: string
  effort: CronEffort
}

export const TASK_TIERS = ['very simple', 'normal', 'very hard'] as const
export type TaskTier = (typeof TASK_TIERS)[number]

// CODEX§14 AGY§21
export const TIER_PICKS: Record<BackendId, Record<TaskTier, Pick>> = {
  claude: {
    'very simple': { model: 'sonnet', effort: 'low' },
    normal: { model: 'opus', effort: 'medium' },
    'very hard': { model: 'fable', effort: 'high' }
  },
  codex: {
    'very simple': { model: 'luna', effort: 'low' },
    normal: { model: 'sol', effort: 'medium' },
    'very hard': { model: 'astra', effort: 'high' }
  },
  muse: {
    'very simple': { effort: 'low' },
    normal: { effort: 'medium' },
    'very hard': { effort: 'high' }
  },
  agy: {
    'very simple': { model: 'flash', effort: 'low' },
    normal: { model: 'argon', effort: 'medium' },
    'very hard': { model: 'carbon', effort: 'high' }
  }
}

const WITHOUT_FABLE: Pick = { model: 'opus', effort: 'xhigh' }

export const pickFlags = (pick: Pick): string =>
  `${pick.model ? `--model ${pick.model} ` : ''}--effort ${pick.effort}`

export const tierModelOf = (backend: BackendId, model: string | undefined): boolean =>
  TASK_TIERS.some((tier) => TIER_PICKS[backend][tier].model === model)

export const tierPicksOf = (backend: BackendId): string =>
  TASK_TIERS.map((tier) => `${tier}: ${pickFlags(TIER_PICKS[backend][tier])}`).join('; ')

export const tiersOf = (backend: BackendId): string =>
  `${BACKEND_LABEL[backend]}: ${tierPicksOf(backend)}`

export interface ListedModel {
  id: string
  efforts: CronEffort[]
}

export interface PickFacts {
  fableLeft: boolean
  listed?: ListedModel[]
}

const knownEfforts = (values: unknown[]): CronEffort[] =>
  CRON_EFFORTS.filter((e) => values.includes(e))

// CODEX§14
export function codexListedModels(reply: unknown): ListedModel[] {
  const data = (reply as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  return data.flatMap((m: { id?: unknown; supportedReasoningEfforts?: unknown }) =>
    typeof m?.id !== 'string'
      ? []
      : [
          {
            id: m.id,
            efforts: knownEfforts(
              (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []).map(
                (e: unknown) => (e as { reasoningEffort?: unknown })?.reasoningEffort ?? e
              )
            )
          }
        ]
  )
}

// AGY§21
export function agyListedModels(stdout: string): ListedModel[] {
  const efforts = new Map<string, CronEffort[]>()
  for (const line of stdout.split('\n')) {
    const id = line.split('\t')[0].trim()
    const cut = id.lastIndexOf('-')
    const effort = id.slice(cut + 1)
    if (cut < 1 || !isCronEffort(effort)) continue
    const base = id.slice(0, cut)
    efforts.set(base, [...(efforts.get(base) ?? []), effort])
  }
  return [...efforts].map(([id, taken]) => ({ id, efforts: knownEfforts(taken) }))
}

const lastKnown = (backend: BackendId): ListedModel[] =>
  NAMED_MODELS[backend].map((m) => ({ id: m.id, efforts: [...effortsFor(backend, m.id)] }))

function versionOf(id: string): number[] {
  return (id.match(/\d+(?:\.\d+)*/)?.[0] ?? '0').split('.').map(Number)
}

function newer(a: string, b: string): boolean {
  const [x, y] = [versionOf(a), versionOf(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

export function newestOf(family: string, listed: ListedModel[]): ListedModel | undefined {
  return listed
    .filter((m) => m.id.endsWith(`-${family}`))
    .reduce<ListedModel | undefined>(
      (best, m) => (!best || newer(m.id, best.id) ? m : best),
      undefined
    )
}

function runsOn(
  backend: BackendId,
  wanted: string,
  listed: ListedModel[]
): { model?: ListedModel; fellBack: boolean } {
  const found = listed.find((m) => m.id === wanted) ?? newestOf(wanted, listed)
  if (found) return { model: found, fellBack: false }
  const stand = TIER_PICKS[backend].normal.model
  const hard = TIER_PICKS[backend]['very hard'].model
  return { model: wanted === hard && stand ? newestOf(stand, listed) : undefined, fellBack: true }
}

const runsInstead = (read: boolean, wanted: string, instead: string): string =>
  read
    ? `This account has no ${wanted} model, so it runs on ${instead}.`
    : `Koloft could not read this account's models, so it runs on ${instead}.`

export const ownPickOf = (model?: string, effort?: CronEffort): OwnPick | undefined =>
  model || effort ? { ...(model && { model }), ...(effort && { effort }) } : undefined

export function cleanOwnPick(raw: unknown): OwnPick | undefined {
  if (!isRecord(raw)) return undefined
  return ownPickOf(
    typeof raw.model === 'string' && isValidModelName(raw.model) ? raw.model : undefined,
    isCronEffort(raw.effort) ? raw.effort : undefined
  )
}

export function familyEfforts(
  backend: BackendId,
  listed: ListedModel[] | undefined
): Record<string, CronEffort[]> {
  const list = listed?.length ? listed : lastKnown(backend)
  return Object.fromEntries(
    TASK_TIERS.flatMap((tier) => {
      const family = TIER_PICKS[backend][tier].model
      const model = family && runsOn(backend, family, list).model
      return family && model ? [[family, model.efforts]] : []
    })
  )
}

export interface OwnPickResolved {
  pick: OwnPick
  note?: string
}

export const listsModels = (backend: BackendId): boolean => backend === 'codex' || backend === 'agy'

export function resolveOwnPick(
  backend: BackendId,
  asked: OwnPick,
  listed: ListedModel[] | undefined
): OwnPickResolved {
  const named = asked.model
  if (!named || !listsModels(backend) || !tierModelOf(backend, named))
    return { pick: ownPickOf(named, takenEffort(backend, named, asked.effort)) ?? {} }
  const read = !!listed?.length
  const { model, fellBack } = runsOn(backend, named, read ? listed! : lastKnown(backend))
  const effort = model
    ? asked.effort && model.efforts.includes(asked.effort)
      ? asked.effort
      : undefined
    : takenEffort(backend, undefined, asked.effort)
  const pick = ownPickOf(model?.id, effort) ?? {}
  if (!fellBack) return { pick }
  return {
    pick,
    note: runsInstead(read, named, model?.id ?? `${BACKEND_LABEL[backend]}'s own model`)
  }
}

export type ResolvedPick = { ok: true; pick: Pick; note?: string } | { ok: false; error: string }

const familiesOf = (listed: ListedModel[]): string =>
  listed.map((m) => `${m.id} (${m.efforts.join('|')})`).join(', ')

export function resolvePick(backend: BackendId, asked: Pick, facts: PickFacts): ResolvedPick {
  const hard = TIER_PICKS[backend]['very hard']
  if (backend === 'claude')
    return asked.model === hard.model && !facts.fableLeft
      ? {
          ok: true,
          pick: WITHOUT_FABLE,
          note: `No Claude account has ${hard.model} allowance left, so it runs on ${pickFlags(WITHOUT_FABLE)}.`
        }
      : { ok: true, pick: asked }
  if (backend === 'muse' || !asked.model) return { ok: true, pick: asked }
  const read = !!facts.listed?.length
  const listed = facts.listed?.length ? facts.listed : lastKnown(backend)
  // AGY§21
  const namesItsEffort = `-${asked.effort}`
  const wanted = asked.model.endsWith(namesItsEffort)
    ? asked.model.slice(0, -namesItsEffort.length)
    : asked.model
  const { model, fellBack } = runsOn(backend, wanted, listed)
  if (!model)
    return {
      ok: false,
      error: `${BACKEND_LABEL[backend]} has no model "${wanted}" for this account; it has ${familiesOf(listed)}.`
    }
  if (!model.efforts.includes(asked.effort))
    return {
      ok: false,
      error: `${model.id} does not take --effort ${asked.effort}; it takes ${model.efforts.join(', ')}.`
    }
  return {
    ok: true,
    pick: { model: model.id, effort: asked.effort },
    ...(fellBack && { note: runsInstead(read, wanted, model.id) })
  }
}
