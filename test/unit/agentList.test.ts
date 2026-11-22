import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { AgentManifest } from '@core/agent/manifest'
import { AGENT_IDS, type AgentId } from '@core/agent/registry'
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

  it('gives the agent id type only the ids on the list, so a name no manifest carries does not compile', () => {
    // @ts-expect-error
    const stranger: AgentId = 'not-on-the-list'
    expect(AGENT_IDS).not.toContain(stranger)
  })
})
