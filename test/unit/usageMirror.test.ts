import { describe, expect, it } from 'vitest'
import { machineUsageDirs } from '../../src/main/remote/usageMirror'
import { remoteBase } from '../../src/main/remote/paths'
import { codexUsageFolders } from '../../src/agents/codex/main/codexMirror'
import { agyFoldersToMirror } from '../../src/agents/agy/main/agyMirror'

describe('the usage folders pulled from a machine', () => {
  it('land where the lister reads that machine, and copy conversation dbs whole', () => {
    const dirs = machineUsageDirs('/ud', 'box')
    const landing = remoteBase('/ud', 'box')
    const [codex] = codexUsageFolders(landing)
    const [, agy] = agyFoldersToMirror(landing)
    expect(codex.to).toBe(`${dirs.codexHome}/sessions`)
    expect(agy.to).toBe(`${dirs.geminiDir}/antigravity-cli/conversations`)
    expect('flags' in agy && agy.flags).toEqual(['--delete', '--include=*.db', '--exclude=*'])
  })
})
