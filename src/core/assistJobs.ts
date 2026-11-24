// ADR-0051
import type { BackendId } from '@shared/types'
import { agentManifest } from './agent/registry'
import type { ModelAndEffort } from './assistModels'
import { PLUGINS } from '@plugins/list'

export const ASSIST_JOBS = PLUGINS.flatMap((p) => p.assistJobs ?? [])

const NO_DEFAULTS: ModelAndEffort = {}

export function assistJobDefaults(job: string, backend: BackendId): ModelAndEffort {
  const kind = ASSIST_JOBS.find((j) => j.id === job)?.kind
  return kind ? agentManifest(backend).smallJobModels[kind] : NO_DEFAULTS
}
