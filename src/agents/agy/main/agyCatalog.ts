import { foldersUpToRoot } from '../../../main/mcpServers'

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
