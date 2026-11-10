import { describe, expect, it } from 'vitest'
import { museAsk } from '../../src/main/museServe'

describe('what a waiting Muse session asks', () => {
  // MUSE§5
  it('names the command, the web address or the file an approval is for, and marks only a file it writes as one', () => {
    expect(
      museAsk({
        approvals: [
          {
            approvalId: 'a1',
            toolName: 'bash',
            rawArgs: '{"command": "ls -la", "sandbox_permissions": "require_escalated"}',
            subject: { kind: 'shell', command: 'ls -la', workspaceRoot: '/r' }
          }
        ],
        userInputs: []
      })
    ).toEqual({ approval: { id: 'a1', command: 'ls -la' } })
    expect(
      museAsk({
        approvals: [
          {
            approvalId: 'a2',
            toolName: 'write_file',
            rawArgs: '{"path": "/r/.git/config", "content": "x"}',
            subject: { kind: 'fileAccess', access: 'write', path: '/r/.git/config' }
          }
        ]
      })
    ).toEqual({ approval: { id: 'a2', command: '/r/.git/config', file: '/r/.git/config' } })
    expect(
      museAsk({ approvals: [{ approvalId: 'a3', rawArgs: '{"url": "https://example.com"}' }] })
    ).toEqual({ approval: { id: 'a3', command: 'https://example.com' } })
  })

  // MUSE§11
  it('takes every question, each open to the owner’s own words, one that picks several marked so with the fewest and most picks it takes', () => {
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
    ).toEqual({ question: { id: 'u3', questions: [taken, { ...taken, multiSelect: true }] } })
    expect(
      museAsk({
        userInputs: [
          {
            userInputId: 'u4',
            questions: [
              { ...question, selection: { mode: 'multiple', minSelections: 2, maxSelections: 2 } }
            ]
          }
        ]
      })
    ).toEqual({
      question: { id: 'u4', questions: [{ ...taken, multiSelect: true, fewest: 2, most: 2 }] }
    })
  })
})
