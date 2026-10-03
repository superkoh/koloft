import { describe, it, expect } from 'vitest'
import {
  askText,
  claudeKeysFor,
  codexKeyFor,
  dialogText,
  hookAnswer,
  isAskedCall
} from '../../src/main/discord/dialog'

const colour = {
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      {
        question: 'Which colour?',
        header: 'Colour',
        options: [
          { label: 'Red', description: 'The red one' },
          { label: 'Green', description: 'The green one' },
          { label: 'No' }
        ],
        multiSelect: false
      }
    ]
  }
}

const plan = {
  tool_name: 'ExitPlanMode',
  tool_input: { plan: 'Create plan-ok.txt.', planFilePath: '/tmp/plan.md' }
}

function decisionOf(out: Record<string, unknown>): Record<string, unknown> {
  const h = out.hookSpecificOutput as { hookEventName: string; decision: Record<string, unknown> }
  expect(h.hookEventName).toBe('PermissionRequest')
  return h.decision
}

describe('the conductor’s own dialog, asked in Discord and answered from there', () => {
  it('shows the question and every option, numbered', () => {
    expect(askText(colour)).toBe(
      '❓ Which colour?\n1. Red — The red one\n2. Green — The green one\n3. No\n\nReply with a number or your own answer.'
    )
    expect(askText(plan)).toContain('Create plan-ok.txt.')
  })

  it('a number picks that option’s label, and any other text is the answer itself', () => {
    expect(decisionOf(hookAnswer(colour, '2'))).toEqual({
      behavior: 'allow',
      updatedInput: { ...colour.tool_input, answers: { 'Which colour?': 'Green' } }
    })
    expect(decisionOf(hookAnswer(colour, 'purple, please'))).toMatchObject({
      updatedInput: { answers: { 'Which colour?': 'purple, please' } }
    })
  })

  it('"no" refuses the question with the owner’s words, unless "No" is one of its options', () => {
    const own = { ...colour, tool_input: { questions: [{ question: 'Go?', options: [] }] } }
    expect(decisionOf(hookAnswer(own, 'no, stop here'))).toEqual({
      behavior: 'deny',
      message: 'no, stop here'
    })
    expect(decisionOf(hookAnswer(colour, 'no'))).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which colour?': 'no' } }
    })
  })

  // CC§14
  it('approving a plan hands the plan back unchanged, since a bare allow is ignored', () => {
    expect(decisionOf(hookAnswer(plan, 'yes'))).toEqual({
      behavior: 'allow',
      updatedInput: plan.tool_input
    })
    expect(decisionOf(hookAnswer(plan, 'Add a test first.'))).toEqual({
      behavior: 'deny',
      message: 'Add a test first.'
    })
  })

  // CODEX§3
  it('a Codex approval is answered by y for yes and Esc for no, and anything else presses nothing', () => {
    expect(codexKeyFor('yes')).toBe('y')
    expect(codexKeyFor('Y')).toBe('y')
    expect(codexKeyFor('no')).toBe('\x1b')
    expect(codexKeyFor('maybe later')).toBeUndefined()
  })
})

describe('a managed session’s dialog: its full text, and the keys that answer it on another machine', () => {
  const bash = {
    tool_name: 'Bash',
    tool_input: { command: 'npm test -- --all', description: 'Run' }
  }

  it('the notice carries the whole question with numbered options, the whole plan, or the command', () => {
    expect(dialogText(colour)).toBe(
      'Which colour?\n1. Red — The red one\n2. Green — The green one\n3. No'
    )
    expect(dialogText(plan)).toBe('Approve this plan?\n\nCreate plan-ok.txt.')
    expect(dialogText(bash)).toBe('Bash asks to run:\nnpm test -- --all')
    expect(dialogText({ tool_name: 'Write', tool_input: { file_path: '/a', content: 'x' } })).toBe(
      'Write asks to run:\n{"file_path":"/a","content":"x"}'
    )
  })

  // CC§14
  it('a number presses that option, own words press the option after the last, then type and Enter; a second question or many picks are refused', () => {
    expect(claudeKeysFor(colour, '2')).toEqual({ ok: true, value: ['2'] })
    expect(claudeKeysFor(colour, 'Purple')).toEqual({ ok: true, value: ['4', 'Purple', '\r'] })
    expect(claudeKeysFor(colour, '7')).toEqual({ ok: true, value: ['4', '7', '\r'] })
    const two = {
      ...colour,
      tool_input: { questions: [...colour.tool_input.questions, colour.tool_input.questions[0]] }
    }
    expect(claudeKeysFor(two, '1').ok).toBe(false)
    const many = {
      ...colour,
      tool_input: { questions: [{ ...colour.tool_input.questions[0], multiSelect: true }] }
    }
    expect(claudeKeysFor(many, '1').ok).toBe(false)
  })

  // CC§14
  it('an approval or a plan takes 1 for yes and Esc for no, and nothing else', () => {
    for (const p of [bash, plan]) {
      expect(claudeKeysFor(p, 'yes')).toEqual({ ok: true, value: ['1'] })
      expect(claudeKeysFor(p, 'no')).toEqual({ ok: true, value: ['\x1b'] })
      expect(claudeKeysFor(p, 'Add a test first.').ok).toBe(false)
    }
  })

  // CC§14
  it('a finished call is the asked one when its name matches and every input it has matches the question’s', () => {
    expect(isAskedCall(bash, { name: 'Bash', input: bash.tool_input })).toBe(true)
    expect(isAskedCall(plan, { name: 'ExitPlanMode', input: {} })).toBe(true)
    expect(isAskedCall(bash, { name: 'Bash', input: { command: 'ls' } })).toBe(false)
    expect(isAskedCall(bash, { name: 'Read', input: {} })).toBe(false)
  })
})
