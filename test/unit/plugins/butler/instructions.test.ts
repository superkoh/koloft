import { describe, expect, it } from 'vitest'
import {
  INSTRUCTIONS_MAX_BYTES,
  instructionsOf,
  savedByTheOwner
} from '../../../../src/plugins/butler/shared/instructions'
import { instructionsBytes, OWNER } from '../../../../src/core/ownerInstructions'
import { promptParts } from '../../../../src/main/launchPrompt'
import { butlerHelperRole, butlerRole } from '../../../../src/plugins/butler/api'
import { ownerInstructionsPart } from '../../../../src/plugins/butler/prompts/role'
import { renamedButler } from '../../../../src/plugins/butler/shared/names'
import { sanitizeLoadedSettings } from '../../../../src/shared/settingsOps'
import type { ButlerSetting } from '../../../../src/plugins/butler/shared/types'
import { DISCORD_BOUND } from '../../../../src/plugins/discord/api'
import { sessionStartContext } from '../../../../src/main/museHooks'
import {
  handoverPreamble,
  withHandover
} from '../../../../src/plugins/sessions/main/handoverPreamble'
import { koloftPrompt } from '../../../../src/plugins/sessions/api'

const BUTLER: ButlerSetting = { name: 'Alfred', formerNames: [] }

const butlerPrompt = (name: string, facts: readonly string[], text: string): string =>
  promptParts(butlerRole(name, facts), text && ownerInstructionsPart(text)).join('\n\n')
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
// MUSE§1
const MUSE_FIRST_MESSAGE_SEEN_WHOLE_BYTES = 122_866

describe('how long the owner’s instructions for the butler may be', () => {
  it.each([
    ['plain letters', 'a'],
    ['line breaks, which a Muse hook doubles', '\n'],
    ['quotes, which a Muse hook doubles', '"'],
    ['Chinese', '中'],
    ['emoji', '😀']
  ])(
    'at the limit, written in %s, fit a Muse start hook of their own, beside the one holding the role of a butler with the longest name and every fact',
    (_, unit) => {
      const text = textOfBytes(unit, INSTRUCTIONS_MAX_BYTES)
      expect(instructionsBytes(text)).toBeLessThanOrEqual(INSTRUCTIONS_MAX_BYTES)
      expect(() => sessionStartContext(ownerInstructionsPart(text))).not.toThrow()
      expect(() => sessionStartContext(butlerRole(LONGEST_NAME, EVERY_FACT))).not.toThrow()
    }
  )

  it('a Muse helper’s first message — its role with the owner’s text at the limit, the handover — stays within the length seen reaching the model whole', () => {
    const text = textOfBytes('中', INSTRUCTIONS_MAX_BYTES)
    const handover = handoverPreamble({
      name: LONGEST_NAME,
      id: 'muse:local:01a13795-6b09-7531-bdd6-84ce54f976ea',
      label: 'Muse',
      assist: true,
      ownerWords: '中'.repeat(500)
    })
    const firstMessage = withHandover(
      `${butlerHelperRole(LONGEST_NAME, text)}\n\n${handover}`,
      'Sort the inbox.'
    )
    expect(Buffer.byteLength(firstMessage)).toBeLessThanOrEqual(MUSE_FIRST_MESSAGE_SEEN_WHOLE_BYTES)
  })

  it('a Claude Code butler’s role, which goes through its start hook while the owner’s text goes beside it, stays under what that hook hands on whole', () => {
    expect(butlerRole(LONGEST_NAME, EVERY_FACT).length).toBeLessThanOrEqual(
      CLAUDE_START_HOOK_MAX_UNITS
    )
  })

  it('a Codex butler’s developer instructions at the limit stay within the length seen reaching the model whole', () => {
    const text = textOfBytes('中', INSTRUCTIONS_MAX_BYTES)
    expect(Buffer.byteLength(butlerPrompt(LONGEST_NAME, EVERY_FACT, text))).toBeLessThanOrEqual(
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
    expect(Buffer.byteLength(butlerPrompt(LONGEST_NAME, EVERY_FACT, text))).toBeLessThanOrEqual(
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
  it('are held to the butler’s own limit', () => {
    const saved = savedByTheOwner(BUTLER, 'a'.repeat(INSTRUCTIONS_MAX_BYTES + 12), '', 1)
    expect(saved).toEqual({ ok: false, error: 'The instructions are 12 over the limit.' })
  })

  it('keeps the owner’s text as a version by the owner, and changes nothing when the text is the same once cleaned', () => {
    const saved = savedByTheOwner(BUTLER, ' Be brief.\r\n', '', 1)
    if (!saved.ok) throw new Error(saved.error)
    expect(saved.butler.instructions).toEqual([{ text: 'Be brief.', at: 1, by: OWNER }])
    expect(savedByTheOwner(saved.butler, 'Be brief. ', 'Be brief.', 2)).toEqual(saved)
  })

  it('changed by an agent while the editor was open are kept when the owner saves the text as opened, and kept with the owner told when the owner typed; a second Save then puts the owner’s text in', () => {
    const opened = 'Be brief.'
    const agreed = 'Be brief.\nAsk before merging.'
    const butler = { ...BUTLER, instructions: [{ text: agreed, at: 1, by: 'Alfred' }] }
    expect(savedByTheOwner(butler, opened, opened, 2)).toEqual({ ok: true, butler })
    const typed = 'Answer in Chinese.'
    expect(savedByTheOwner(butler, typed, opened, 2)).toEqual({
      ok: false,
      error: expect.stringMatching(/Save again/),
      inUse: agreed
    })
    const again = savedByTheOwner(butler, typed, agreed, 3)
    expect(again.ok && instructionsOf(again.butler)).toBe(typed)
  })

  it('survive renaming the butler and reading the settings back', () => {
    const saved = savedByTheOwner(BUTLER, 'Be brief.', '', 1)
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
  })

  it('leave the prompt exactly as it was when none are written', () => {
    expect(butlerHelperRole('Alfred', '')).toBe(butlerHelperRole('Alfred'))
  })
})
