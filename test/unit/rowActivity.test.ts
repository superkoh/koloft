import { describe, expect, it } from 'vitest'
import {
  agyToolDid,
  claudeAskLine,
  claudeToolDid,
  museToolDid,
  storedAskLine
} from '../../src/main/rowActivity'

describe('what a row says each agent did, in plain words', () => {
  it('Claude Code: a command, a file it changed, wrote or read, a search, a helper, any other tool', () => {
    expect(claudeToolDid('Bash', { command: 'npm  test\n--watch' })).toBe('Ran npm test --watch')
    expect(claudeToolDid('Edit', { file_path: '/r/src/foo.ts' })).toBe('Edited foo.ts')
    expect(claudeToolDid('Write', { file_path: '/r/a.md' })).toBe('Wrote a.md')
    expect(claudeToolDid('Read', { file_path: '/r/a.md' })).toBe('Read a.md')
    expect(claudeToolDid('Grep', { pattern: 'TODO' })).toBe('Searched for TODO')
    expect(claudeToolDid('Agent', { description: 'Find the bug' })).toBe(
      'Started a helper: Find the bug'
    )
    expect(claudeToolDid('mcp__github__create_issue', {})).toBe('Used create_issue')
  })

  it('Claude Code: asking you is not something it did', () => {
    expect(claudeToolDid('AskUserQuestion', { questions: [] })).toBeUndefined()
    expect(claudeToolDid('ExitPlanMode', { plan: 'x' })).toBeUndefined()
  })

  it('Muse Code: its own tool names, the written file from the tool reply', () => {
    expect(museToolDid('bash', { command: 'ls' }, {})).toBe('Ran ls')
    expect(museToolDid('edit_file', {}, { filePath: '/r/b.ts' })).toBe('Edited b.ts')
    expect(museToolDid('write_file', {}, { filePath: '/r/c.ts' })).toBe('Wrote c.ts')
    expect(museToolDid('read_file', { path: 'docs/d.md' }, {})).toBe('Read d.md')
    expect(museToolDid('monitor', {}, {})).toBe('Used monitor')
  })

  it('Antigravity: its own tool names, and no line for its question tool', () => {
    const args: Record<string, string> = { CommandLine: 'make', TargetFile: '/r/e.go' }
    const arg = (k: string): string | undefined => args[k]
    expect(agyToolDid('run_command', arg)).toBe('Ran make')
    expect(agyToolDid('replace_file_content', arg)).toBe('Edited e.go')
    expect(agyToolDid('write_to_file', arg)).toBe('Wrote e.go')
    expect(agyToolDid('search_web', arg)).toBe('Used search_web')
    expect(agyToolDid('ask_question', arg)).toBeUndefined()
  })
})

describe('what a row says while the session waits on you', () => {
  it('Claude Code: the first question it asks, a plan to approve, a command or a file edit it wants', () => {
    expect(
      claudeAskLine({
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            { question: 'English or Chinese?', options: ['English', 'Chinese'] },
            { question: 'Second?', options: ['a'] }
          ]
        }
      })
    ).toBe('Asks: English or Chinese?')
    expect(claudeAskLine({ tool_name: 'ExitPlanMode', tool_input: { plan: '1. a' } })).toBe(
      'Asks: Approve this plan?'
    )
    expect(claudeAskLine({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })).toBe(
      'Wants to run: rm -rf build'
    )
    expect(claudeAskLine({ tool_name: 'Edit', tool_input: { file_path: '/r/x.ts' } })).toBe(
      'Wants to edit: x.ts'
    )
  })

  it('Codex, Muse Code and Antigravity: a question, a command, a file edit or a plan', () => {
    expect(storedAskLine({ id: 1, question: 'Which one?', options: [{ label: 'A' }] })).toBe(
      'Asks: Which one?'
    )
    expect(storedAskLine({ id: 2, command: 'rm -rf build' })).toBe('Wants to run: rm -rf build')
    expect(storedAskLine({ id: 3, command: '/r/e.go', file: '/r/e.go' })).toBe(
      'Wants to edit: e.go'
    )
    expect(
      storedAskLine({ id: 4, command: 'plan.md', reason: 'Approve the plan', plan: true })
    ).toBe('Asks: Approve this plan?')
    expect(storedAskLine({ id: 5, reason: 'Write outside the folder' })).toBe(
      'Asks: Write outside the folder'
    )
  })
})
