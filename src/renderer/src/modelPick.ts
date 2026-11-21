export interface ModelPick {
  model: string
  modelOther: string
}

export function modelValue(f: ModelPick): string | undefined {
  if (f.model === '') return undefined
  if (f.model === 'other') return f.modelOther.trim()
  return f.model
}
