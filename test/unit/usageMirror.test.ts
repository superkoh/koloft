import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { remoteBase } from '../../src/main/remote/paths'
import { codexUsageFolders } from '../../src/agents/codex/main/codexMirror'
import { agyFoldersToMirror } from '../../src/agents/agy/main/agyMirror'
import { codexUsage } from '../../src/agents/codex/main/codexUsage'
import { agyUsage } from '../../src/agents/agy/main/agyUsage'

let userData: string

afterEach(() => fs.rmSync(userData, { recursive: true, force: true }))

describe('the usage folders pulled from a machine', () => {
  it('land where each agent lists that machine, and copy conversation dbs whole', async () => {
    userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-mirror-')))
    const landing = remoteBase(userData, 'box')
    const [codex] = codexUsageFolders(landing)
    const [brain, conversations] = agyFoldersToMirror(landing)
    const rollout = path.join(codex.to, '2026', '10', '15', 'rollout-1.jsonl')
    fs.mkdirSync(path.dirname(rollout), { recursive: true })
    fs.writeFileSync(rollout, '')
    fs.mkdirSync(path.join(brain.to, 'c1'), { recursive: true })
    const noSessions = () => null
    const never = () => '/not/this/mac'

    const codexFiles = await codexUsage(noSessions, never, () => userData).filesIn('box')
    const agyFiles = await agyUsage(noSessions, never, () => userData).filesIn('box')

    expect(codexFiles.map((f) => [f.file, f.host])).toEqual([[rollout, 'box']])
    expect(agyFiles.map((f) => [path.dirname(f.db!), f.host])).toEqual([[conversations.to, 'box']])
    expect('flags' in conversations && conversations.flags).toEqual([
      '--delete',
      '--include=*.db',
      '--exclude=*'
    ])
  })
})
