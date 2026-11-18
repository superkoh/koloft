// ADR-0051
import type { BackendId } from '@shared/types'
import type { ModelAndEffort } from './assistModels'
import { PLUGINS } from '@plugins/list'

export const ASSIST_JOBS = PLUGINS.flatMap((p) => p.assistJobs ?? [])

const NO_DEFAULTS: ModelAndEffort = {}

export const assistJobDefaults = (job: string, backend: BackendId): ModelAndEffort =>
  ASSIST_JOBS.find((j) => j.id === job)?.defaults[backend] ?? NO_DEFAULTS
