import { CRON_EFFORTS, type BackendId, type CronEffort } from './types'

export interface NamedModel {
  id: string
  label: string
}

export const NAMED_MODELS: Record<BackendId, NamedModel[]> = {
  claude: [
    { id: 'fable', label: 'Fable' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' }
  ],
  // CODEX§14
  codex: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
    { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna' }
  ],
  // MUSE§1
  muse: [],
  // AGY§21
  agy: [
    { id: 'gemini-4-argon', label: 'Gemini 4 Argon' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' }
  ]
}

export function namedModel(backend: BackendId, id: string | undefined): NamedModel | undefined {
  return NAMED_MODELS[backend].find((m) => m.id === id)
}

const LOW_MEDIUM_HIGH: readonly CronEffort[] = ['low', 'medium', 'high']
const AGY_EFFORTS_EVERY_MODEL_TAKES: readonly CronEffort[] = ['low', 'high']
const AGY_EFFORTS_OF: ReadonlyMap<string, readonly CronEffort[]> = new Map([
  ['gemini-4-argon', LOW_MEDIUM_HIGH],
  ['gemini-3.8-flash', LOW_MEDIUM_HIGH],
  ['gemini-3.7-flash', LOW_MEDIUM_HIGH],
  ['gemini-3.6-flash', LOW_MEDIUM_HIGH],
  ['gemini-3.1-pro', AGY_EFFORTS_EVERY_MODEL_TAKES]
])

export function effortsFor(backend: BackendId, model: string | undefined): readonly CronEffort[] {
  if (backend !== 'agy') return CRON_EFFORTS
  // AGY§21
  const named = model && LOW_MEDIUM_HIGH.find((e) => model.endsWith(`-${e}`))
  if (named) return [named]
  return (model && AGY_EFFORTS_OF.get(model)) || AGY_EFFORTS_EVERY_MODEL_TAKES
}

export function takenEffort(
  backend: BackendId,
  model: string | undefined,
  effort: CronEffort | undefined
): CronEffort | undefined {
  return effort && effortsFor(backend, model).includes(effort) ? effort : undefined
}
