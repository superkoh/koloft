import { describe, it, expect, expectTypeOf } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { AgentManifest } from '@core/agent/manifest'
import type { AgentId } from '@core/agent/registry'
import { AGENTS } from '@agents/list'

const AGENT_FOLDERS = path.join(__dirname, '..', '..', 'src', 'agents')

describe('the list of agents', () => {
  it('holds the manifest of every agent folder once, and each manifest carries its folder name as its id', async () => {
    const folders = fs
      .readdirSync(AGENT_FOLDERS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
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
})
