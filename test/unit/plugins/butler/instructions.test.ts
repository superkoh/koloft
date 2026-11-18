import { describe, expect, it } from 'vitest'
import {
  INSTRUCTIONS_MAX_BYTES,
  instructionsBytes,
  instructionsOf,
  OWNER,
  savedInstructions
} from '../../../../src/plugins/butler/shared/instructions'
import { butlerHelperRole, butlerRole } from '../../../../src/plugins/butler/api'
import { ownerInstructionsPart } from '../../../../src/plugins/butler/prompts/role'
import { renamedButler } from '../../../../src/plugins/butler/shared/names'
import { sanitizeLoadedSettings } from '../../../../src/shared/settingsOps'
import type { ButlerSetting } from '../../../../src/plugins/butler/shared/types'
import { DISCORD_BOUND } from '../../../../src/plugins/discord/api'
import { sessionStartContext } from '../../../../src/main/museHooks'
import { handoverPreamble } from '../../../../src/main/handover'
import { koloftPrompt } from '../../../../src/plugins/sessions/api'

const BUTLER: ButlerSetting = { name: 'Alfred', formerNames: [] }
const LONGEST_NAME = '𝔄'.repeat(40)
const EVERY_FACT = [DISCORD_BOUND]

const textOfBytes = (unit: string, bytes: number): string =>
  unit.repeat(Math.floor(bytes / instructionsBytes(unit)))

// CC§13
const CLAUDE_START_HOOK_MAX_UNITS = 10_000
// CODEX§17
const CODEX_INSTRUCTIONS_SEEN_WHOLE_BYTES = 22_438
// AGY§12
const AGY_START_MESSAGE_SEEN_WHOLE_BYTES = 300_000

describe('how long the owner’s instructions for the butler may be', () => {
  it.each([
    ['plain letters', 'a'],
    ['line breaks, which a Muse hook doubles', '\n'],
    ['quotes, which a Muse hook doubles', '"'],
    ['Chinese', '中'],
    ['emoji', '😀']
  ])(
    'at the limit, written in %s, a Muse butler with the longest name and every fact still starts',
    (_, unit) => {
      const text = textOfBytes(unit, INSTRUCTIONS_MAX_BYTES)
      expect(instructionsBytes(text)).toBeLessThanOrEqual(INSTRUCTIONS_MAX_BYTES)
      expect(() => sessionStartContext(butlerRole(LONGEST_NAME, EVERY_FACT, text))).not.toThrow()
    }
  )

  it('a Claude Code butler’s role, which goes through its start hook while the owner’s text goes beside it, stays under what that hook hands on whole', () => {
    expect(butlerRole(LONGEST_NAME, EVERY_FACT).length).toBeLessThanOrEqual(
      CLAUDE_START_HOOK_MAX_UNITS
    )
  })

  it('a Codex butler’s developer instructions at the limit stay within the length seen reaching the model whole', () => {
    const text = textOfBytes('中', INSTRUCTIONS_MAX_BYTES)
    expect(Buffer.byteLength(butlerRole(LONGEST_NAME, EVERY_FACT, text))).toBeLessThanOrEqual(
      CODEX_INSTRUCTIONS_SEEN_WHOLE_BYTES
    )
  })

  it('a Codex helper’s developer instructions — Koloft’s prompt, its role with the owner’s text at the limit, the handover — stay within the length seen reaching the model whole', () => {
    const text = textOfBytes('中', INSTRUCTIONS_MAX_BYTES)
    const handover = handoverPreamble({
      name: LONGEST_NAME,
      id: 'codex:local:019a-thread',
      label: 'Codex',
      assist: true,
      ownerWords: '中'.repeat(500)
    })
    const developerInstructions = [
      koloftPrompt('codex'),
      `${butlerHelperRole(LONGEST_NAME, text)}\n\n${handover}`
    ].join('\n\n')
    expect(Buffer.byteLength(developerInstructions)).toBeLessThanOrEqual(
      CODEX_INSTRUCTIONS_SEEN_WHOLE_BYTES
    )
  })

  it('an Antigravity butler’s start message at the limit stays within the length seen reaching the model whole', () => {
    const text = textOfBytes('中', INSTRUCTIONS_MAX_BYTES)
    expect(Buffer.byteLength(butlerRole(LONGEST_NAME, EVERY_FACT, text))).toBeLessThanOrEqual(
      AGY_START_MESSAGE_SEEN_WHOLE_BYTES
    )
  })

  it('is counted in the bytes a Muse hook spends on it', () => {
    expect(instructionsBytes('ab')).toBe(2)
    expect(instructionsBytes('中')).toBe(3)
    expect(instructionsBytes('a\n"b')).toBe(6)
  })
})

describe('saving the owner’s instructions', () => {
  it('keeps each change as a version, newest last, and the newest is the text in use', () => {
    const first = savedInstructions(BUTLER, 'Answer in Chinese.', OWNER, 1)
    if (!first.ok) throw new Error(first.error)
    const second = savedInstructions(first.butler, 'Be brief.', OWNER, 2)
    if (!second.ok) throw new Error(second.error)
    expect(second.butler.instructions).toEqual([
      { text: 'Answer in Chinese.', at: 1, by: OWNER },
      { text: 'Be brief.', at: 2, by: OWNER }
    ])
    expect(instructionsOf(second.butler)).toBe('Be brief.')
  })

  it('records no change when the text is the same once cleaned', () => {
    const first = savedInstructions(BUTLER, 'Be brief.', OWNER, 1)
    if (!first.ok) throw new Error(first.error)
    expect(savedInstructions(first.butler, '  Be brief.\r\n', OWNER, 2)).toEqual(first)
  })

  it('drops characters that cannot be seen, keeps line breaks and tabs, and trims the ends', () => {
    const saved = savedInstructions(BUTLER, ' one\r\n\ttwo\u0007\u001b[0m ', OWNER, 1)
    expect(saved.ok && instructionsOf(saved.butler)).toBe('one\n\ttwo[0m')
  })

  it('refuses text over the limit and says by how much', () => {
    const saved = savedInstructions(BUTLER, 'a'.repeat(INSTRUCTIONS_MAX_BYTES + 12), OWNER, 1)
    expect(saved).toEqual({ ok: false, error: 'The instructions are 12 over the limit.' })
  })

  it('keeps the last twenty versions', () => {
    let butler = BUTLER
    for (let at = 1; at <= 25; at++) {
      const saved = savedInstructions(butler, `rule ${at}`, OWNER, at)
      if (!saved.ok) throw new Error(saved.error)
      butler = saved.butler
    }
    expect(butler.instructions?.map((v) => v.at)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 6)
    )
  })

  it('survive renaming the butler and reading the settings back', () => {
    const saved = savedInstructions(BUTLER, 'Be brief.', OWNER, 1)
    if (!saved.ok) throw new Error(saved.error)
    expect(instructionsOf(renamedButler(saved.butler, 'Jeeves'))).toBe('Be brief.')
    const loaded = sanitizeLoadedSettings({ butler: saved.butler })
    expect(loaded.butler.instructions).toEqual(saved.butler.instructions)
    expect(
      sanitizeLoadedSettings({ butler: { name: 'Alfred', instructions: [{ text: 1 }, 'x'] } })
        .butler
    ).toEqual(BUTLER)
  })
})

describe('the owner’s instructions in the butler’s prompt', () => {
  it('come last, after the helper’s own paragraph, once', () => {
    const role = butlerHelperRole('Alfred', 'Be brief.')
    expect(role.endsWith('\n\nWritten by the owner\nBe brief.')).toBe(true)
    expect(role.split('Written by the owner')).toHaveLength(2)
  })

  it('arrive as written, even when they hold what looks like a slot', () => {
    const text = '{{butler-name}} {{nope}} $& $1'
    expect(ownerInstructionsPart(text)).toBe(`Written by the owner\n${text}`)
    expect(butlerRole('Alfred', [], text).endsWith(text)).toBe(true)
  })

  it('leave the prompt exactly as it was when none are written', () => {
    expect(butlerRole('Alfred', [], '')).toBe(butlerRole('Alfred'))
    expect(butlerHelperRole('Alfred', '')).toBe(butlerHelperRole('Alfred'))
  })
})
