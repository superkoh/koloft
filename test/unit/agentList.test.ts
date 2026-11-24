import { describe, it, expect, expectTypeOf } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { AgentManifest } from '@core/agent/manifest'
import type { AgentId } from '@core/agent/registry'
import { AGENTS } from '@agents/list'

const AGENT_FOLDERS = path.join(__dirname, '..', '..', 'src', 'agents')
const PARTS_SEVERAL_AGENTS_SHARE = 'kit'

describe('the list of agents', () => {
  it('holds the manifest of every agent folder once, and each manifest carries its folder name as its id', async () => {
    const folders = fs
      .readdirSync(AGENT_FOLDERS, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== PARTS_SEVERAL_AGENTS_SHARE)
      .map((e) => e.name)
    expect(AGENTS).toHaveLength(folders.length)
    for (const folder of folders) {
      const { agent } = (await import(path.join(AGENT_FOLDERS, folder, 'agent.ts'))) as {
        agent: AgentManifest
      }
      expect(agent.id).toBe(folder)
      expect(AGENTS).toContain(agent)
    }
  })

  it('the typecheck of the tests fails once the agent id type takes any string, not only the ids on the list', () => {
    expectTypeOf<string>().not.toExtend<AgentId>()
  })

  // CC§30 CODEX§17 AGY§32
  it('each agent lists the instruction file it reads first as the first of its instruction files, since text that says which file to write in takes that one', () => {
    expect(
      Object.fromEntries(AGENTS.map((agent) => [agent.id, agent.instructionFileNames[0]]))
    ).toEqual({
      claude: 'CLAUDE.md',
      codex: 'AGENTS.md',
      agy: 'AGENTS.md'
    })
  })
})
