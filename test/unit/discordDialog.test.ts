import { describe, it, expect } from 'vitest'
import {
  askHow,
  claudeDialog,
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
  it('shows the question and every option, numbered, with a button per option that answers its number', () => {
    expect(claudeDialog(colour)).toEqual({
      text: 'Which colour?\n1. Red — The red one\n2. Green — The green one\n3. No',
      choices: [
        { label: '1. Red', reply: '1', style: 'secondary' },
        { label: '2. Green', reply: '2', style: 'secondary' },
        { label: '3. No', reply: '3', style: 'secondary' }
      ]
    })
    expect(askHow(colour)).toBe('Reply with a number or your own answer.')
    expect(claudeDialog(plan).text).toContain('Create plan-ok.txt.')
    expect(claudeDialog(plan).choices.map((c) => [c.label, c.reply])).toEqual([
      ['Approve', 'yes'],
      ['Reject', 'no']
    ])
  })

  it('gets no buttons when one button cannot hold the whole answer: several questions, or several picks', () => {
    const two = {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { question: 'A?', options: [{ label: 'x' }] },
          { question: 'B?', options: [{ label: 'y' }] }
        ]
      }
    }
    const many = {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [{ question: 'Which?', options: [{ label: 'x' }], multiSelect: true }]
      }
    }
    expect(claudeDialog(two).choices).toEqual([])
    expect(claudeDialog(many).choices).toEqual([])
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

  it('a many-pick answer reads numbers and names alike, on one line split by commas or one per line, and sends the picked labels in option order, as the keys of the same reply would', () => {
    const fruit = {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Which fruits?',
            options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
            multiSelect: true
          }
        ]
      }
    }
    for (const reply of ['3, 1, cherry,', '1\ncherry'])
      expect(decisionOf(hookAnswer(fruit, reply))).toMatchObject({
        updatedInput: { answers: { 'Which fruits?': 'Apple, Cherry' } }
      })
    expect(decisionOf(hookAnswer(fruit, 'Mango juice'))).toMatchObject({
      updatedInput: { answers: { 'Which fruits?': 'Mango juice' } }
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
      updatedInput: { answers: { 'Which colour?': 'No' } }
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
  it('a number or a label presses that option, own words press the option after the last, then type and Enter', () => {
    expect(claudeKeysFor(colour, '2')).toEqual({ ok: true, value: ['2'] })
    expect(claudeKeysFor(colour, 'green')).toEqual({ ok: true, value: ['2'] })
    expect(claudeKeysFor(colour, 'Purple')).toEqual({ ok: true, value: ['4', 'Purple', '\r'] })
    expect(claudeKeysFor(colour, '7')).toEqual({ ok: true, value: ['4', '7', '\r'] })
  })

  // CC§14
  it('several questions take one line each: a pick moves on, picks of a many-pick question are ticked and Tab moves on, own words go in its last row, and 1 on the review page sends them all', () => {
    const [q] = colour.tool_input.questions
    const fruit = {
      question: 'Which fruits?',
      options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
      multiSelect: true
    }
    const ask = (...questions: object[]): typeof colour =>
      ({ ...colour, tool_input: { questions } }) as typeof colour
    const DOWN = '\x1b[B'
    expect(claudeKeysFor(ask(q, fruit), '2\n1, cherry')).toEqual({
      ok: true,
      value: ['2', '1', '3', '\t', '1']
    })
    expect(claudeKeysFor(ask(fruit, q), 'Mango juice\nPurple')).toEqual({
      ok: true,
      value: [DOWN, DOWN, DOWN, 'Mango juice', '\t', '\r', '4', 'Purple', '\r', '1']
    })
    expect(claudeKeysFor(ask(fruit), '3, 1, 3,')).toEqual({
      ok: true,
      value: ['1', '3', '\t', '1']
    })
    expect(claudeKeysFor(ask(fruit), '1\ncherry')).toEqual({
      ok: true,
      value: ['1', '3', '\t', '1']
    })
    expect(claudeKeysFor(colour, 'Purple\nstripes')).toEqual({
      ok: true,
      value: ['4', 'Purple stripes', '\r']
    })
    expect(claudeKeysFor(ask(q, fruit), '2')).toEqual({
      ok: false,
      error: askHow(ask(q, fruit))
    })
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

  // CC§14
  it('a question answered in the terminal is the asked call, though the transcript orders its keys differently from the hook', () => {
    const [q] = colour.tool_input.questions
    const asWritten = {
      questions: [
        { question: q.question, header: q.header, multiSelect: q.multiSelect, options: q.options }
      ]
    }
    expect(isAskedCall(colour, { name: 'AskUserQuestion', input: asWritten })).toBe(true)
  })
})
