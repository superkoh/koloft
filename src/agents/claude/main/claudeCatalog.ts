import path from 'path'
import type { McpServer } from '@shared/types'
import { runsPlaywrightMcp } from '../../../main/browserControlEnv'
import {
  asRecord,
  foldersUpToRoot,
  jsonServers,
  listed,
  parsed,
  textOrNull,
  turnedOn,
  type ConfigText
} from '../../../main/mcpServers'
import { realpathSafe } from '../../../main/projectInfo'
import { claudeJsonPath, claudeProjectKey } from './claudeTrust'

// CC§22
export const PROJECT_MCP_FILE = '.mcp.json'

export interface ClaudeFolder {
  folder: string
  projectKey: string
}

// CC§22
export function claudeServers(
  claudeJson: string | null,
  projectFiles: ConfigText[],
  folders: ClaudeFolder[]
): McpServer[] {
  const doc = parsed(claudeJson)
  const projects = asRecord(doc.projects)
  return [
    ...listed('claude', doc.mcpServers),
    ...folders.flatMap(({ folder, projectKey }) =>
      listed('claude', asRecord(projects[projectKey]).mcpServers, folder)
    ),
    ...jsonServers('claude', projectFiles)
  ]
}

// ADR-0048 CC§22 CC§24
export function claudePlaywrightServers(
  claudeJson: string | null,
  projectFilesFarthestFirst: (string | null)[],
  projectKey: string
): string[] {
  const doc = parsed(claudeJson)
  const loaded = Object.assign(
    {},
    asRecord(doc.mcpServers),
    ...projectFilesFarthestFirst.map((text) => asRecord(parsed(text).mcpServers)),
    asRecord(asRecord(asRecord(doc.projects)[projectKey]).mcpServers)
  )
  return turnedOn(loaded)
    .filter(([, entry]) => runsPlaywrightMcp(entry.command, entry.args))
    .map(([name]) => name)
}

// ADR-0048 CC§22 CC§24
export async function ownersClaudePlaywrightMcp(cwd: string): Promise<string[]> {
  const [claudeJson, ...projectFiles] = await Promise.all([
    textOrNull(claudeJsonPath()),
    ...foldersUpToRoot(realpathSafe(cwd))
      .reverse()
      .map((folder) => textOrNull(path.join(folder, PROJECT_MCP_FILE)))
  ])
  return claudePlaywrightServers(claudeJson, projectFiles, claudeProjectKey(cwd))
}
