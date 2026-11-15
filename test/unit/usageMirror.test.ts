import { describe, expect, it } from 'vitest'
import { machineUsageDirs, usagePulls } from '../../src/main/remote/usageMirror'

describe('usagePulls', () => {
  it('pulls only the usage folders of the agents a machine has history for', () => {
    const none = usagePulls('/ud', 'box', { codex: false, muse: false, agy: false })
    const all = usagePulls('/ud', 'box', { codex: true, muse: true, agy: true })
    expect(none).toEqual([])
    expect(all.map((p) => p.from)).toEqual([
      '.koloft/codex-home/sessions',
      '.koloft/codex-home/archived_sessions',
      '.local/share/muse/sessions',
      '.gemini/antigravity-cli/conversations'
    ])
    expect(all.every((p) => p.failsQuietly)).toBe(true)
  })

  it('lands each pull where the lister reads that machine, and copies conversation dbs whole', () => {
    const dirs = machineUsageDirs('/ud', 'box')
    const [codex, , muse, agy] = usagePulls('/ud', 'box', { codex: true, muse: true, agy: true })
    expect(codex.to).toBe(`${dirs.codexHome}/sessions`)
    expect(muse.to).toBe(`${dirs.museHome}/sessions`)
    expect(agy.to).toBe(`${dirs.geminiDir}/antigravity-cli/conversations`)
    expect(agy.flags).toEqual(['--delete', '--include=*.db', '--exclude=*'])
  })
})
