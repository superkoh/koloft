import { TASK_TIERS, type ModelPick as Pick, type TaskTier } from '@core/agent/manifest'
import { agentManifest, ofEachAgent } from '@core/agent/registry'
import { CRON_EFFORTS, isCronEffort, type BackendId, type CronEffort, type OwnPick } from './types'
import { BACKEND_LABEL } from './sessionBackend'
import { NAMED_MODELS, effortsFor, namedModel, takenEffort } from './cronModels'
import { isValidModelName } from './cronNames'
import { isRecord } from './workbenchState'

export const TIER_PICKS: Record<BackendId, Record<TaskTier, Pick>> = ofEachAgent(
  (id) => agentManifest(id).picksByTaskTier
)

const WITHOUT_FABLE: Pick = { model: 'opus', effort: 'xhigh' }

export const pickFlags = (pick: Pick): string => `--model ${pick.model} --effort ${pick.effort}`

export const familyNamesOf = (backend: BackendId): string[] => [
  ...new Set(
    TASK_TIERS.flatMap((tier) => [
      TIER_PICKS[backend][tier].model,
      tier === 'normal' ? agentManifest(backend).normalTaskFamilyEveryAccountHas : undefined
    ]).filter((family): family is string => !!family)
  )
]

export const familyModelOf = (backend: BackendId, model: string | undefined): boolean =>
  !!model && familyNamesOf(backend).includes(model)

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
  NAMED_MODELS[backend]
    .filter((m) => !m.notOnEveryAccount)
    .map((m) => ({ id: m.id, efforts: [...effortsFor(backend, m.id)] }))

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
  const instead =
    wanted === hard
      ? stand
      : wanted === stand
        ? agentManifest(backend).normalTaskFamilyEveryAccountHas
        : undefined
  return { model: instead ? runsOn(backend, instead, listed).model : undefined, fellBack: true }
}

const runsInstead = (read: boolean, wanted: string, instead: string): string =>
  read
    ? `This account has no ${wanted} model, so it runs on ${instead}.`
    : `Koloft could not read this account's models, so it runs on ${instead}.`

const highestTakenUpTo = (asked: CronEffort, model: ListedModel): CronEffort | undefined =>
  CRON_EFFORTS.slice(0, CRON_EFFORTS.indexOf(asked) + 1)
    .filter((e) => model.efforts.includes(e))
    .pop()

const effortOn = (
  model: ListedModel,
  asked: CronEffort | undefined,
  fellBack: boolean
): CronEffort | undefined =>
  !asked
    ? undefined
    : fellBack
      ? highestTakenUpTo(asked, model)
      : model.efforts.includes(asked)
        ? asked
        : undefined

const onModelAt = (id: string, effort: CronEffort | undefined, asked?: CronEffort): string =>
  effort && effort !== asked ? `${id} at ${effort}` : id

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
    familyNamesOf(backend).flatMap((family) => {
      const model = runsOn(backend, family, list).model
      return model ? [[family, model.efforts]] : []
    })
  )
}

export interface OwnPickResolved {
  pick: OwnPick
  note?: string
}

export const listsModels = (backend: BackendId): boolean => backend === 'codex' || backend === 'agy'

const familyOfAModelSomeAccountsLack = (backend: BackendId, id: string): string | undefined =>
  namedModel(backend, id)?.notOnEveryAccount
    ? familyNamesOf(backend).find((family) => id.endsWith(`-${family}`))
    : undefined

export const needsTheAccountsModels = (backend: BackendId, model: string | undefined): boolean =>
  !!model &&
  listsModels(backend) &&
  (familyModelOf(backend, model) || !!familyOfAModelSomeAccountsLack(backend, model))

export function resolveOwnPick(
  backend: BackendId,
  asked: OwnPick,
  listed: ListedModel[] | undefined
): OwnPickResolved {
  const named = asked.model
  if (!named || !needsTheAccountsModels(backend, named))
    return { pick: ownPickOf(named, takenEffort(backend, named, asked.effort)) ?? {} }
  const read = !!listed?.length
  const models = read ? listed! : lastKnown(backend)
  const wanted = models.some((m) => m.id === named)
    ? named
    : (familyOfAModelSomeAccountsLack(backend, named) ?? named)
  const ran = runsOn(backend, wanted, models)
  const model = ran.model
  const fellBack = ran.fellBack || wanted !== named
  if (!model) {
    const pick = ownPickOf(undefined, takenEffort(backend, undefined, asked.effort)) ?? {}
    return { pick, note: runsInstead(read, named, `${BACKEND_LABEL[backend]}'s own model`) }
  }
  const effort = effortOn(model, asked.effort, fellBack)
  const pick = ownPickOf(model.id, effort) ?? {}
  if (!fellBack) return { pick }
  return { pick, note: runsInstead(read, named, onModelAt(model.id, effort, asked.effort)) }
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
  const effort = effortOn(model, asked.effort, fellBack)
  if (!effort)
    return {
      ok: false,
      error: `${model.id} does not take --effort ${asked.effort}; it takes ${model.efforts.join(', ')}.`
    }
  return {
    ok: true,
    pick: { model: model.id, effort },
    ...(fellBack && { note: runsInstead(read, wanted, onModelAt(model.id, effort, asked.effort)) })
  }
}
