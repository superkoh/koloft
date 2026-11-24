import type { NamedModel } from '@core/agent/manifest'
import { agentManifest, ofEachAgent } from '@core/agent/registry'
import type { BackendId, CronEffort } from './types'

export type { NamedModel }

export const NAMED_MODELS: Record<BackendId, NamedModel[]> = ofEachAgent((id) => [
  ...agentManifest(id).namedModels
])

export function namedModel(backend: BackendId, id: string | undefined): NamedModel | undefined {
  return NAMED_MODELS[backend].find((m) => m.id === id)
}

export function effortsFor(backend: BackendId, model: string | undefined): readonly CronEffort[] {
  return agentManifest(backend).pureFunctions.effortsAModelTakes(model)
}

export function effortNotTaken(
  backend: BackendId,
  model: string | undefined,
  effort: CronEffort | undefined
): string | null {
  if (!effort || takenEffort(backend, model, effort)) return null
  return `${model ?? 'the default model'} does not take --effort ${effort}; it takes ${effortsFor(backend, model).join(', ')}.`
}

export function takenEffort(
  backend: BackendId,
  model: string | undefined,
  effort: CronEffort | undefined
): CronEffort | undefined {
  return effort && effortsFor(backend, model).includes(effort) ? effort : undefined
}
