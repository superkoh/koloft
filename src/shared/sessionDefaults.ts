import { isCronEffort, type BackendId, type OwnPick, type SessionDefaults } from './types'
import { SESSION_BACKENDS } from './sessionBackend'
import { NAMED_MODELS, type NamedModel } from './cronModels'
import { isValidModelName } from './cronNames'
import { TASK_TIERS, TIER_PICKS } from './sessionPicks'
import { isRecord } from './workbenchState'

export const NO_DEFAULTS: SessionDefaults = { picks: {} }

const capitalized = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1)

export function ownPickModels(backend: BackendId): NamedModel[] {
  if (backend === 'claude') return NAMED_MODELS.claude
  return TASK_TIERS.flatMap((tier) => {
    const family = TIER_PICKS[backend][tier].model
    return family ? [{ id: family, label: capitalized(family) }] : []
  })
}

function sanitizePick(raw: unknown): OwnPick | undefined {
  if (!isRecord(raw)) return undefined
  const model = typeof raw.model === 'string' && isValidModelName(raw.model) ? raw.model : undefined
  const effort = isCronEffort(raw.effort) ? raw.effort : undefined
  return model || effort ? { ...(model && { model }), ...(effort && { effort }) } : undefined
}

export function sanitizeDefaults(raw: unknown): SessionDefaults | undefined {
  if (!isRecord(raw)) return undefined
  const picksIn = isRecord(raw.picks) ? raw.picks : {}
  const picks = Object.fromEntries(
    SESSION_BACKENDS.flatMap((b) => {
      const pick = sanitizePick(picksIn[b])
      return pick ? [[b, pick]] : []
    })
  )
  const rules = typeof raw.rules === 'string' ? raw.rules.trim() : ''
  if (!rules && Object.keys(picks).length === 0) return undefined
  return { picks, ...(rules && { rules }) }
}

export function sanitizeSessionDefaults(raw: unknown): Record<string, SessionDefaults> {
  if (!isRecord(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]) => {
      const kept = sanitizeDefaults(value)
      return kept ? [[key, kept]] : []
    })
  )
}

export const takesOwnDefaults = (launch: {
  model?: string
  effort?: string
  resumeSessionId?: string
}): boolean => !launch.resumeSessionId && !launch.model && !launch.effort

export function cronPickFor(
  backend: BackendId,
  job: OwnPick,
  defaults: SessionDefaults | undefined
): OwnPick {
  const own = defaults?.picks[backend]
  const model = job.model ?? own?.model
  const effort = job.effort ?? own?.effort
  return { ...(model && { model }), ...(effort && { effort }) }
}
