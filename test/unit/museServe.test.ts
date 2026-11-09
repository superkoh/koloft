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
    for (const toolName of ['write_file', 'edit_file'])
      expect(
        museAsk({
          approvals: [
            {
              approvalId: 'a2',
              toolName,
              rawArgs: '{"path": "/r/.git/config", "content": "x"}',
              subject: { kind: 'fileAccess', access: 'write', path: '/r/.git/config', toolName }
            }
          ]
        })
      ).toEqual({ approval: { id: 'a2', command: '/r/.git/config', file: '/r/.git/config' } })
    expect(
      museAsk({ approvals: [{ approvalId: 'a3', rawArgs: '{"url": "https://example.com"}' }] })
    ).toEqual({ approval: { id: 'a3', command: 'https://example.com' } })
    expect(
      museAsk({
        approvals: [{ approvalId: 'a4', toolName: 'read_file', rawArgs: '{"path": "/r/a.ts"}' }]
      })
    ).toEqual({ approval: { id: 'a4' } })
    expect(museAsk({ approvals: [{ approvalId: 'a5', rawArgs: 'not json' }] })).toEqual({
      approval: { id: 'a5' }
    })
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
