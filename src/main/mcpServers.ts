import fs from 'fs'
import path from 'path'
import type { BackendId, McpServer } from '@shared/types'
import { runsPlaywrightMcp } from './browserControlEnv'
import { claudeJsonPath, claudeProjectKey } from '@agents/claude/main/claudeTrust'
import { isGitCheckoutAsync, realpathSafe } from './projectInfo'

export interface ConfigText {
  text: string | null
  onlyIn?: string
}

// CC§22
export const PROJECT_MCP_FILE = '.mcp.json'
// AGY§30
export const AGY_PROJECT_MCP_FILE = '.agents/mcp_config.json'

// CC§22
export function foldersUpToRoot(folder: string): string[] {
  const parent = path.dirname(folder)
  return parent === folder ? [folder] : [folder, ...foldersUpToRoot(parent)]
}

// AGY§30
export async function foldersUpToRepoTop(
  folder: string,
  holdsGit: (folder: string) => Promise<boolean>
): Promise<string[]> {
  const up = foldersUpToRoot(folder)
  const top = (await Promise.all(up.map(holdsGit))).indexOf(true)
  return top < 0 ? [folder] : up.slice(0, top + 1)
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function parsed(text: string | null): Record<string, unknown> {
  try {
    return asRecord(text === null ? null : JSON.parse(text))
  } catch {
    return {}
  }
}

const turnedOn = (raw: unknown): [string, Record<string, unknown>][] =>
  Object.entries(asRecord(raw))
    .map(([name, entry]): [string, Record<string, unknown>] => [name, asRecord(entry)])
    .filter(([, entry]) => entry.disabled !== true)

function listed(backend: BackendId, raw: unknown, onlyIn?: string): McpServer[] {
  return turnedOn(raw).map(([name]) => ({ name, backend, ...(onlyIn && { onlyIn }) }))
}

export function jsonServers(backend: BackendId, files: ConfigText[]): McpServer[] {
  return files.flatMap((f) => listed(backend, parsed(f.text).mcpServers, f.onlyIn))
}

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

const CODEX_TABLE = /^[ \t]*\[[ \t]*(?:"[^"\n]*"|[^\]\s"])+[ \t]*\]/gm
const CODEX_SERVER_TABLE = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]/
const TURNED_OFF = /^\s*enabled\s*=\s*false\b/m

// CODEX§15
export function codexServers(configToml: string | null): McpServer[] {
  const text = configToml ?? ''
  const starts = [...text.matchAll(CODEX_TABLE)].map((m) => m.index ?? 0)
  const names = starts.flatMap((start, i) => {
    const table = text.slice(start, starts[i + 1])
    const m = CODEX_SERVER_TABLE.exec(table)
    return m && !TURNED_OFF.test(table) ? [m[1] ?? m[2]] : []
  })
  return [...new Set(names)].map((name) => ({ name, backend: 'codex' as const }))
}
