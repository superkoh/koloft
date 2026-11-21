import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OWNER,
  instructionsBytes,
  textInUse,
  type InstructionsVersion
} from '../../../../src/core/ownerInstructions'
import {
  everyWorkspaceBlock,
  everyWorkspaceSavedByTheOwner,
  koloftPrompt,
  ownerPartsOf,
  workspaceInstructionsPart
} from '../../../../src/plugins/sessions/api'
import { everyWorkspacePart } from '../../../../src/plugins/sessions/main/everyWorkspaceInstructions'
import {
  EVERY_WORKSPACE_TEXT_MAX_BYTES,
  WORKSPACE_TEXT_MAX_BYTES,
  workspaceTextBytes
} from '../../../../src/plugins/sessions/shared/workspaceInstructions'
import { sessionStartContext, writeMuseHooks } from '../../../../src/main/museHooks'
import { sanitizeLoadedSettings } from '../../../../src/shared/settingsOps'
import type { SessionDefaults } from '../../../../src/shared/types'

// CODEX§17
const CODEX_APP_SERVER_INSTRUCTIONS_SEEN_WHOLE_BYTES = 24_604

const SHARED: InstructionsVersion[] = [{ text: 'Answer me in Chinese.', at: 1, by: OWNER }]
const OWN: SessionDefaults = {
  picks: {},
  instructions: [{ text: 'Run npm test first.', at: 1, by: OWNER }]
}

const textOfBytes = (unit: string, bytes: number): string =>
  unit.repeat(Math.floor(bytes / instructionsBytes(unit)))

describe('what a new session gets of the instructions the owner wrote', () => {
  it('gets the instructions for every workspace first, then its own workspace’s, each under its heading', () => {
    expect(ownerPartsOf(SHARED, OWN, false)).toEqual([
      'Written by the owner for every workspace\nAnswer me in Chinese.',
      'Written by the owner for this workspace\nRun npm test first.'
    ])
    expect(ownerPartsOf(SHARED, undefined, false)).toEqual([
      everyWorkspacePart('Answer me in Chinese.')
    ])
  })

  it('gets exactly what it got before while the instructions for every workspace are empty, so an upgrade changes nothing', () => {
    expect(ownerPartsOf([], OWN, false)).toEqual([workspaceInstructionsPart('Run npm test first.')])
    expect(ownerPartsOf([{ text: '', at: 2, by: OWNER }], OWN, false)).toEqual([
      workspaceInstructionsPart('Run npm test first.')
    ])
    expect(sanitizeLoadedSettings({ sessionDefaults: {} }).everyWorkspaceInstructions).toEqual([])
  })

  it('gets none of them in a workspace that leaves them out, and none in the butler’s folder', () => {
    expect(ownerPartsOf(SHARED, { ...OWN, leavesOutEveryWorkspace: true }, false)).toEqual([
      workspaceInstructionsPart('Run npm test first.')
    ])
    expect(ownerPartsOf(SHARED, undefined, true)).toEqual([])
  })

  it('a workspace that only leaves them out keeps that choice when the settings are read back', () => {
    const settings = sanitizeLoadedSettings({
      sessionDefaults: { 'octo/app': { picks: {}, leavesOutEveryWorkspace: true } },
      everyWorkspaceInstructions: [...SHARED, { text: 1 }]
    })
    expect(settings.sessionDefaults).toEqual({
      'octo/app': { picks: {}, leavesOutEveryWorkspace: true }
    })
    expect(settings.everyWorkspaceInstructions).toEqual(SHARED)
  })
})

describe('how long the instructions for every workspace may be', () => {
  it.each([
    ['plain letters', 'a'],
    ['line breaks, which a Muse hook doubles', '\n'],
    ['quotes, which a Muse hook doubles', '"'],
    ['Chinese', '中'],
    ['emoji', '😀']
  ])('at the limit, written in %s, they fit one Muse start hook of their own', (_, unit) => {
    const text = textOfBytes(unit, EVERY_WORKSPACE_TEXT_MAX_BYTES)
    expect(() => sessionStartContext(everyWorkspacePart(text))).not.toThrow()
  })

  it('a Codex session with both blocks at their limits stays within the length seen reaching the model whole', () => {
    const own = textOfBytes('中', WORKSPACE_TEXT_MAX_BYTES - workspaceTextBytes('', ''))
    const shared = textOfBytes('中', EVERY_WORKSPACE_TEXT_MAX_BYTES)
    const text = [
      koloftPrompt('codex'),
      everyWorkspacePart(shared),
      workspaceInstructionsPart(own)
    ].join('\n\n')
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      CODEX_APP_SERVER_INSTRUCTIONS_SEEN_WHOLE_BYTES
    )
  })

  it('are refused past the limit, with by how much, and kept as a version by the owner within it', () => {
    expect(
      everyWorkspaceSavedByTheOwner([], 'a'.repeat(EVERY_WORKSPACE_TEXT_MAX_BYTES + 3), '', 1)
    ).toEqual({ ok: false, error: 'The instructions are 3 over the limit.' })
    expect(
      everyWorkspaceSavedByTheOwner(SHARED, ' Be brief.\r\n', 'Answer me in Chinese.', 2)
    ).toEqual({
      ok: true,
      versions: [...SHARED, { text: 'Be brief.', at: 2, by: OWNER }]
    })
  })

  it('changed by an agent while the editor was open are kept, and the owner is shown them, not overwritten', () => {
    const agreed: InstructionsVersion[] = [
      ...SHARED,
      { text: 'Agreed meanwhile.', at: 2, by: 'Codex' }
    ]
    expect(
      everyWorkspaceSavedByTheOwner(agreed, 'Typed.', 'Answer me in Chinese.', 3)
    ).toMatchObject({
      ok: false,
      inUse: 'Agreed meanwhile.'
    })
  })
})

describe('the instructions for every workspace, changed by an agent', () => {
  it('keep the proposing session’s name on the new version, and write nothing when the text moved meanwhile', async () => {
    let versions = [...SHARED]
    const block = everyWorkspaceBlock(
      () => versions,
      (v) => (versions = v),
      () => 9
    )
    expect(block.forEveryWorkspace).toBe(true)
    expect(await block.writeIfStill('Something else', 'x', 'Fix login')).toBe(false)
    expect(await block.writeIfStill('Answer me in Chinese.', 'Be brief.', 'Fix login')).toBe(true)
    expect(versions.at(-1)).toEqual({ text: 'Be brief.', at: 9, by: 'Fix login' })
    expect(textInUse(versions)).toBe(await block.read())
  })
})

describe('a Muse session’s start hooks', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

  it('print each part of its text from a start hook of its own, in order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-hooks-'))
    dirs.push(dir)
    const parts = [
      'Koloft prompt.',
      everyWorkspacePart('Shared "rule".'),
      workspaceInstructionsPart('Own rule.')
    ]
    const file = writeMuseHooks(dir, dir, parts)
    const starts = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionStart[0].hooks as {
      command: string
    }[]
    const printed = starts.map(({ command }) =>
      execFileSync('/bin/bash', ['-c', command], { input: '{}', encoding: 'utf8' }).trim()
    )
    expect(printed).toEqual(parts.map(sessionStartContext))
  })
})
