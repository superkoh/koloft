import fs from 'fs'
import path from 'path'
import type { BackendId, McpServer } from '@shared/types'
import { claudeJsonPath, claudeProjectKey } from '@agents/claude/main/claudeTrust'
import { PROJECT_MCP_FILE, claudeServers } from '@agents/claude/main/claudeCatalog'
import { codexServers } from '@agents/codex/main/codexCatalog'
import { AGY_PROJECT_MCP_FILE, foldersUpToRepoTop } from '@agents/agy/main/agyCatalog'
import { isGitCheckoutAsync } from './projectInfo'

export interface ConfigText {
  text: string | null
  onlyIn?: string
}

// CC§22
export function foldersUpToRoot(folder: string): string[] {
  const parent = path.dirname(folder)
  return parent === folder ? [folder] : [folder, ...foldersUpToRoot(parent)]
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export function parsed(text: string | null): Record<string, unknown> {
  try {
    return asRecord(text === null ? null : JSON.parse(text))
  } catch {
    return {}
  }
}

export const turnedOn = (raw: unknown): [string, Record<string, unknown>][] =>
  Object.entries(asRecord(raw))
    .map(([name, entry]): [string, Record<string, unknown>] => [name, asRecord(entry)])
    .filter(([, entry]) => entry.disabled !== true)

export function listed(backend: BackendId, raw: unknown, onlyIn?: string): McpServer[] {
  return turnedOn(raw).map(([name]) => ({ name, backend, ...(onlyIn && { onlyIn }) }))
}

export function jsonServers(backend: BackendId, files: ConfigText[]): McpServer[] {
  return files.flatMap((f) => listed(backend, parsed(f.text).mcpServers, f.onlyIn))
}

export const textOrNull = (file: string): Promise<string | null> =>
  fs.promises.readFile(file, 'utf8').catch(() => null)

export async function mcpServersIn(
  folders: string[],
  codexSharedConfig: () => string,
  ownersGemini: () => string
): Promise<McpServer[]> {
  const walks = await Promise.all(
    folders.map(async (onlyIn) => ({
      onlyIn,
      toRoot: foldersUpToRoot(onlyIn),
      toRepoTop: await foldersUpToRepoTop(onlyIn, isGitCheckoutAsync)
    }))
  )
  const inFolders = (file: string, walk: 'toRoot' | 'toRepoTop'): Promise<ConfigText[]> =>
    Promise.all(
      walks.flatMap((w) =>
        w[walk].map(async (folder) => ({
          onlyIn: w.onlyIn,
          text: await textOrNull(path.join(folder, file))
        }))
      )
    )
  const [claudeJson, projectFiles, agyProjectFiles, codexToml, agy] = await Promise.all([
    textOrNull(claudeJsonPath()),
    inFolders(PROJECT_MCP_FILE, 'toRoot'),
    inFolders(AGY_PROJECT_MCP_FILE, 'toRepoTop'),
    textOrNull(codexSharedConfig()),
    textOrNull(path.join(ownersGemini(), 'config', 'mcp_config.json'))
  ])
  const claudeFolders = folders.map((folder) => ({
    folder,
    projectKey: claudeProjectKey(folder)
  }))
  return [
    ...claudeServers(claudeJson, projectFiles, claudeFolders),
    ...codexServers(codexToml),
    ...jsonServers('agy', [{ text: agy }, ...agyProjectFiles])
  ]
}
