import { describe, expect, it } from 'vitest'
import { museAsk } from '../../src/main/museServe'

describe('what a waiting Muse session asks', () => {
  it('names the command, the web address or the file an approval is for, and marks a file as one', () => {
    expect(museAsk({ approvals: [{ approvalId: 'a3', rawArgs: { path: '/r/a.ts' } }] })).toEqual({
      approval: { id: 'a3', command: '/r/a.ts', file: '/r/a.ts' }
    })
    expect(
      museAsk({ approvals: [{ approvalId: 'a1', rawArgs: { command: 'ls -la' } }], userInputs: [] })
    ).toEqual({ approval: { id: 'a1', command: 'ls -la' } })
    expect(
      museAsk({ approvals: [{ approvalId: 'a2', rawArgs: { url: 'https://example.com' } }] })
    ).toEqual({ approval: { id: 'a2', command: 'https://example.com' } })
  })

  // MUSE§11
  it('takes every question that picks one option, each open to the owner’s own words, and nothing when one of them picks several', () => {
    const question = {
      id: 'color',
      question: 'Which colour?',
      options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }],
      selection: { mode: 'single' }
    }
    const taken = {
      question: 'Which colour?',
      options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }],
      ownWords: true
    }
    expect(
      museAsk({ approvals: [], userInputs: [{ userInputId: 'u1', questions: [question] }] })
    ).toEqual({ question: { id: 'u1', questions: [taken] } })
    expect(
      museAsk({ userInputs: [{ userInputId: 'u2', questions: [question, question] }] })
    ).toEqual({ question: { id: 'u2', questions: [taken, taken] } })
    expect(
      museAsk({
        userInputs: [
          {
            userInputId: 'u3',
            questions: [question, { ...question, selection: { mode: 'multiple' } }]
          }
        ]
      })
    ).toEqual({})
  })
})
