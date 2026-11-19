import { describe, expect, it } from 'vitest'
import { instructionsBytes, OWNER } from '../../../../src/core/ownerInstructions'
import {
  WORKSPACE_TEXT_MAX_BYTES,
  workspaceTextBytes
} from '../../../../src/plugins/sessions/shared/workspaceInstructions'
import {
  instructionsPartOf,
  koloftPrompt,
  savedFromTheDialog,
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

const RULES = 'Docs: sonnet.'

describe('a workspace’s instructions, saved from the Session defaults dialog with its rules', () => {
  it('keep each change as a version by the owner, newest last; the same text adds none, and clearing it keeps the history', () => {
    const first = savedFromTheDialog(
      undefined,
      { picks: {}, instructions: ' Run the tests first.\r\n' },
      1
    )
    const same = savedFromTheDialog(first, { picks: {}, instructions: 'Run the tests first.' }, 2)
    const cleared = savedFromTheDialog(same, { picks: {}, instructions: '' }, 3)
    expect(cleared).toEqual({
      picks: {},
      instructions: [
        { text: 'Run the tests first.', at: 1, by: OWNER },
        { text: '', at: 3, by: OWNER }
      ]
    })
    expect(instructionsPartOf(cleared)).toBeUndefined()
    expect(instructionsPartOf(first)).toBe(
      'Written by the owner for this workspace\nRun the tests first.'
    )
  })

  it('are refused, with by how much, when they and the rules together pass the limit and either of them changed', () => {
    const over = 'a'.repeat(WORKSPACE_TEXT_MAX_BYTES - workspaceTextBytes(RULES, '') + 7)
    expect(() =>
      savedFromTheDialog(undefined, { picks: {}, rules: RULES, instructions: over }, 1)
    ).toThrow('The rules and instructions together are 7 over the limit.')
    const longRules = 'r'.repeat(WORKSPACE_TEXT_MAX_BYTES)
    expect(() =>
      savedFromTheDialog(undefined, { picks: {}, rules: longRules, instructions: '' }, 1)
    ).toThrow('over the limit')
  })

  it('let rules saved before the limit existed stay, so changing only a model pick still saves', () => {
    const longRules = 'r'.repeat(WORKSPACE_TEXT_MAX_BYTES)
    const saved = { picks: {}, rules: longRules }
    expect(
      savedFromTheDialog(
        saved,
        { picks: { claude: { model: 'opus' } }, rules: longRules, instructions: '' },
        1
      )
    ).toEqual({ picks: { claude: { model: 'opus' } }, rules: longRules })
  })

  it('arrive in the prompt as written, even when they hold what looks like a slot', () => {
    const text = '{{owner-instructions}} {{nope}} $& $1'
    expect(workspaceInstructionsPart(text)).toBe(`Written by the owner for this workspace\n${text}`)
  })

  it('survive reading the settings back, and what is not a version is dropped', () => {
    const versions = [{ text: 'Be brief.', at: 1, by: OWNER }]
    expect(
      sanitizeLoadedSettings({
        sessionDefaults: {
          'octo/app': { picks: {}, instructions: versions },
          '/ws/b': { picks: {}, instructions: [{ text: 1 }] }
        }
      }).sessionDefaults
    ).toEqual({ 'octo/app': { picks: {}, instructions: versions } })
  })
})
