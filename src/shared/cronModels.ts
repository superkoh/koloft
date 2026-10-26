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

const AGY_EFFORTS_EVERY_MODEL_TAKES: readonly CronEffort[] = ['low', 'high']
const AGY_EFFORTS_OF: ReadonlyMap<string, readonly CronEffort[]> = new Map([
  ['gemini-4-argon', ['low', 'medium', 'high']],
  ['gemini-3.8-flash', ['low', 'medium', 'high']],
  ['gemini-3.1-pro', ['low', 'high']]
])
const AGY_ID_NAMING_ITS_EFFORT = /-(low|medium|high)$/

export function effortsFor(backend: BackendId, model: string | undefined): readonly CronEffort[] {
  if (backend !== 'agy') return CRON_EFFORTS
  // AGY§21
  if (model && AGY_ID_NAMING_ITS_EFFORT.test(model)) return []
  return (model && AGY_EFFORTS_OF.get(model)) || AGY_EFFORTS_EVERY_MODEL_TAKES
}
