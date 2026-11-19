import { describe, expect, it } from 'vitest'
import { instructionsBytes, OWNER } from '../../../../src/core/ownerInstructions'
import {
  WORKSPACE_TEXT_MAX_BYTES,
  workspaceTextBytes,
  type InstructionsOfWorkspaces
} from '../../../../src/plugins/sessions/shared/workspaceInstructions'
import {
  koloftPrompt,
  workspaceInstructions,
  workspaceInstructionsPart
} from '../../../../src/plugins/sessions/api'
import { sessionStartContext } from '../../../../src/main/museHooks'
import { sanitizeLoadedSettings } from '../../../../src/shared/settingsOps'

// CODEX§17
const CODEX_INSTRUCTIONS_SEEN_WHOLE_BYTES = 22_438

const textOfBytes = (unit: string, bytes: number): string =>
  unit.repeat(Math.floor(bytes / instructionsBytes(unit)))

function rulesOfAbout(unit: string, bytes: number): string {
  const line = unit.repeat(20)
  let rules = line
  while (workspaceTextBytes(`${rules}\n${line}`, '') <= bytes) rules = `${rules}\n${line}`
  return rules
}

const sessionPrompt = (backend: 'codex' | 'muse', rules: string, text: string): string =>
  [koloftPrompt(backend, rules), workspaceInstructionsPart(text)].join('\n\n')

describe('how long a workspace’s instructions may be, together with its rules for picking a model', () => {
  it.each([
    ['plain letters', 'a'],
    ['line breaks, which a Muse hook doubles', '\n'],
    ['quotes, which a Muse hook doubles', '"'],
    ['Chinese', '中'],
    ['emoji', '😀']
  ])(
    'at the limit, written in %s with rules taking half of it, a Muse session on this Mac or a machine still starts',
    (_, unit) => {
      const rules = rulesOfAbout(unit, WORKSPACE_TEXT_MAX_BYTES / 2)
      const text = textOfBytes(unit, WORKSPACE_TEXT_MAX_BYTES - workspaceTextBytes(rules, ''))
      expect(workspaceTextBytes(rules, text)).toBeLessThanOrEqual(WORKSPACE_TEXT_MAX_BYTES)
      expect(() => sessionStartContext(sessionPrompt('muse', rules, text))).not.toThrow()
    }
  )

  it('a Codex session’s developer instructions at the limit stay within the length seen reaching the model whole', () => {
    const rules = rulesOfAbout('中', WORKSPACE_TEXT_MAX_BYTES / 2)
    const text = textOfBytes('中', WORKSPACE_TEXT_MAX_BYTES - workspaceTextBytes(rules, ''))
    expect(Buffer.byteLength(sessionPrompt('codex', rules, text))).toBeLessThanOrEqual(
      CODEX_INSTRUCTIONS_SEEN_WHOLE_BYTES
    )
  })

  it('counts the rules as they stand in the prompt, and nothing for rules left empty', () => {
    expect(workspaceTextBytes('', 'ab')).toBe(2)
    expect(workspaceTextBytes('x', '')).toBeGreaterThan(instructionsBytes('x'))
  })
})

function store(roots: Record<string, string> = {}) {
  let saved: InstructionsOfWorkspaces = {}
  let now = 0
  const instructions = workspaceInstructions({
    rootOf: (dir) => roots[dir] ?? dir,
    saved: () => saved,
    save: (all) => {
      saved = all
    },
    now: () => ++now
  })
  return { instructions, saved: () => saved }
}

describe('a workspace’s instructions, kept per workspace', () => {
  it('keep each change as a version by the owner, newest last, and record nothing when the text is the same', () => {
    const { instructions, saved } = store()
    instructions.write('/ws/a', 'Run the tests first.')
    instructions.write('/ws/a', 'Run the tests first.')
    instructions.write('/ws/a', '')
    expect(saved()['/ws/a']).toEqual([
      { text: 'Run the tests first.', at: 1, by: OWNER },
      { text: '', at: 3, by: OWNER }
    ])
    expect(instructions.textOf('/ws/a')).toBe('')
  })

  it('reach a session in a worktree of that workspace and in no other workspace', () => {
    const { instructions } = store({ '/ws/a/.claude/worktrees/fix': '/ws/a' })
    instructions.write('/ws/a', 'Run the tests first.')
    expect(instructions.partOf('/ws/a/.claude/worktrees/fix')).toBe(
      'Written by the owner for this workspace\nRun the tests first.'
    )
    expect(instructions.partOf('/ws/b')).toBeUndefined()
    expect(instructions.partOf('devbox:/ws/a')).toBeUndefined()
  })

  it('are cleaned before saving, and refused over the limit with by how much, counting the rules too', () => {
    const { instructions } = store()
    expect(instructions.checked(' one\r\n\ttwo\u0007 ', '')).toBe('one\n\ttwo')
    const rules = 'Docs: sonnet.'
    const over = 'a'.repeat(WORKSPACE_TEXT_MAX_BYTES - workspaceTextBytes(rules, '') + 7)
    expect(() => instructions.checked(over, rules)).toThrow(
      'The instructions are 7 over the limit.'
    )
    expect(() => instructions.checked(over, '')).not.toThrow()
  })

  it('arrive in the prompt as written, even when they hold what looks like a slot', () => {
    const text = '{{owner-instructions}} {{nope}} $& $1'
    expect(workspaceInstructionsPart(text)).toBe(`Written by the owner for this workspace\n${text}`)
  })

  it('survive reading the settings back, and what is not a version is dropped', () => {
    const versions = [{ text: 'Be brief.', at: 1, by: OWNER }]
    expect(
      sanitizeLoadedSettings({
        workspaceInstructions: { '/ws/a': versions, '/ws/b': [{ text: 1 }], '/ws/c': 'x' }
      }).workspaceInstructions
    ).toEqual({ '/ws/a': versions })
  })
})
