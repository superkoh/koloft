import path from 'path'
import type { AgentCatalog } from '@core/agent/agentsMain'
import { foldersUpToRoot, jsonServers, textOrNull, textsIn } from '../../../main/mcpServers'

// AGY§30
export const AGY_PROJECT_MCP_FILE = '.agents/mcp_config.json'

// AGY§30
export async function foldersUpToRepoTop(
  folder: string,
  holdsGit: (folder: string) => Promise<boolean>
): Promise<string[]> {
  const up = foldersUpToRoot(folder)
  const top = (await Promise.all(up.map(holdsGit))).indexOf(true)
  return top < 0 ? [folder] : up.slice(0, top + 1)
}

export const agyCatalog = (
  ownersGemini: () => string,
  holdsGit: (folder: string) => Promise<boolean>
): AgentCatalog => ({
  // AGY§4 AGY§31
  moreSkillFoldersEveryAccountReadsOnThisMac: () => [],
  // AGY§30
  mcpServersOn: async (folders) => {
    const walks = await Promise.all(
      folders.map(async (onlyIn) => ({
        onlyIn,
        folders: await foldersUpToRepoTop(onlyIn, holdsGit)
      }))
    )
    const [own, projectFiles] = await Promise.all([
      textOrNull(path.join(ownersGemini(), 'config', 'mcp_config.json')),
      textsIn(walks, AGY_PROJECT_MCP_FILE)
    ])
    return jsonServers('agy', [{ text: own }, ...projectFiles])
  }
})
