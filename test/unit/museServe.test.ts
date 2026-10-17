import { describe, expect, it } from 'vitest'
import { museAsk } from '../../src/main/museServe'

describe('what a waiting Muse session asks', () => {
  it('names the command or the web address an approval is for', () => {
    expect(
      museAsk({ approvals: [{ approvalId: 'a1', rawArgs: { command: 'ls -la' } }], userInputs: [] })
    ).toEqual({ approval: { id: 'a1', command: 'ls -la' } })
    expect(
      museAsk({ approvals: [{ approvalId: 'a2', rawArgs: { url: 'https://example.com' } }] })
    ).toEqual({ approval: { id: 'a2', command: 'https://example.com' } })
  })

  it('takes one question that picks one option, and nothing it could not answer by keys', () => {
    const question = {
      id: 'color',
      question: 'Which colour?',
      options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }],
      selection: { mode: 'single' }
    }
    expect(
      museAsk({ approvals: [], userInputs: [{ userInputId: 'u1', questions: [question] }] })
    ).toEqual({
      question: {
        id: 'u1',
        question: 'Which colour?',
        options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }]
      }
    })
    expect(
      museAsk({ userInputs: [{ userInputId: 'u2', questions: [question, question] }] })
    ).toEqual({})
    expect(
      museAsk({
        userInputs: [
          { userInputId: 'u3', questions: [{ ...question, selection: { mode: 'multiple' } }] }
        ]
      })
    ).toEqual({})
  })
})
