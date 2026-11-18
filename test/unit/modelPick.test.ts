import { describe, expect, it } from 'vitest'
import { modelValue } from '../../src/renderer/src/modelPick'

describe('modelValue', () => {
  it('maps the chips to what the launch line carries', () => {
    const pick = (model: string, modelOther = ''): { model: string; modelOther: string } => ({
      model,
      modelOther
    })
    expect(modelValue(pick(''))).toBeUndefined()
    expect(modelValue(pick('fable'))).toBe('fable')
    expect(modelValue(pick('opus'))).toBe('opus')
    expect(modelValue(pick('sonnet'))).toBe('sonnet')
    expect(modelValue(pick('other', '  claude-opus-5  '))).toBe('claude-opus-5')
  })
})
