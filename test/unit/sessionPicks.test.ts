import { describe, expect, it } from 'vitest'
import { agyListedModels, codexListedModels, newestOf } from '../../src/shared/sessionPicks'

describe('the models an account lists', () => {
  it('reads Codex’s model/list answer, keeping only the efforts Koloft can pass', () => {
    expect(
      codexListedModels({
        data: [
          {
            id: 'gpt-6.1-sol',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'max' },
              { reasoningEffort: 'ultra' }
            ]
          },
          { id: 'gpt-6-luna', supportedReasoningEfforts: ['low', 'medium'] },
          { displayName: 'no id' }
        ]
      })
    ).toEqual([
      { id: 'gpt-6.1-sol', efforts: ['low', 'max'] },
      { id: 'gpt-6-luna', efforts: ['low', 'medium'] }
    ])
    expect(codexListedModels({ data: [] })).toEqual([])
    expect(codexListedModels(undefined)).toEqual([])
  })

  it('reads agy models rows into one model per family with the efforts its rows name', () => {
    expect(
      agyListedModels(
        [
          'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
          'gemini-4-carbon-high\tGemini 4 Carbon (High)',
          'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
          'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
          '',
          'Fetching available models...'
        ].join('\n')
      )
    ).toEqual([
      { id: 'gemini-4-carbon', efforts: ['low', 'medium', 'high'] },
      { id: 'gemini-3.8-flash', efforts: ['high'] }
    ])
  })

  it('takes the highest version of a family, 6.1 over 6 and 3.10 over 3.8', () => {
    const listed = ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-6-astra'].map((id) => ({
      id,
      efforts: []
    }))
    expect(newestOf('sol', listed)?.id).toBe('gpt-6.1-sol')
    expect(newestOf('terra', listed)).toBeUndefined()
    const flash = ['gemini-3.8-flash', 'gemini-3.10-flash'].map((id) => ({ id, efforts: [] }))
    expect(newestOf('flash', flash)?.id).toBe('gemini-3.10-flash')
  })
})
