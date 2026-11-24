import type { CronEffort } from '@shared/efforts'

const LOW_MEDIUM_HIGH: readonly CronEffort[] = ['low', 'medium', 'high']
const LOW_TO_XHIGH: readonly CronEffort[] = [...LOW_MEDIUM_HIGH, 'xhigh']
const AGY_EFFORTS_EVERY_MODEL_TAKES: readonly CronEffort[] = ['low', 'high']
const AGY_EFFORTS_OF: ReadonlyMap<string, readonly CronEffort[]> = new Map([
  ['gemini-4-carbon', LOW_MEDIUM_HIGH],
  ['gemini-4-neon', LOW_TO_XHIGH],
  ['gemini-4-argon', LOW_MEDIUM_HIGH],
  ['gemini-3.8-flash', LOW_MEDIUM_HIGH],
  ['gemini-3.7-flash', LOW_MEDIUM_HIGH],
  ['gemini-3.6-flash', LOW_MEDIUM_HIGH],
  ['gemini-3.1-pro', AGY_EFFORTS_EVERY_MODEL_TAKES]
])

// AGY§21
export function agyEffortsAModelTakes(model: string | undefined): readonly CronEffort[] {
  const named = model && LOW_TO_XHIGH.find((e) => model.endsWith(`-${e}`))
  if (named) return [named]
  return (model && AGY_EFFORTS_OF.get(model)) || AGY_EFFORTS_EVERY_MODEL_TAKES
}
