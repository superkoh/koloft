import type { BackendId } from '@shared/types'
import { BACKEND_LABEL, SESSION_BACKENDS } from '@shared/sessionBackend'

export interface McpServer {
  name: string
  backend: BackendId
  onlyIn?: string
}

export interface ConfigText {
  text: string | null
  onlyIn?: string
}

// CC§22 MUSE§18
export const PROJECT_MCP_FILE = '.mcp.json'
// AGY§30
export const AGY_PROJECT_MCP_FILE = '.agents/mcp_config.json'

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

function listed(backend: BackendId, raw: unknown, onlyIn?: string): McpServer[] {
  return Object.entries(asRecord(raw))
    .filter(([, entry]) => asRecord(entry).disabled !== true)
    .map(([name]) => ({ name, backend, ...(onlyIn && { onlyIn }) }))
}

export function jsonServers(backend: BackendId, files: ConfigText[]): McpServer[] {
  return files.flatMap((f) => listed(backend, parsed(f.text).mcpServers, f.onlyIn))
}

// CC§22
export function claudeServers(claudeJson: string | null, projectFiles: ConfigText[]): McpServer[] {
  const doc = parsed(claudeJson)
  return [
    ...listed('claude', doc.mcpServers),
    ...Object.entries(asRecord(doc.projects)).flatMap(([folder, p]) =>
      listed('claude', asRecord(p).mcpServers, folder)
    ),
    ...jsonServers('claude', projectFiles)
  ]
}

const CODEX_SERVER_TABLE = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]/gm

// CODEX§15
export function codexServers(configToml: string | null): McpServer[] {
  const names = [...(configToml ?? '').matchAll(CODEX_SERVER_TABLE)].map((m) => m[1] ?? m[2])
  return [...new Set(names)].map((name) => ({ name, backend: 'codex' as const }))
}

function reachText(s: McpServer): string {
  return `${BACKEND_LABEL[s.backend]} (${s.onlyIn ? `only in ${s.onlyIn}` : 'everywhere'})`
}

export function mcpLines(servers: McpServer[], mine: BackendId, myFolder: string): string[] {
  if (!servers.length) return ['No agent has an MCP server set up.']
  const names = [...new Set(servers.map((s) => s.name))].sort()
  const lines = names.map(
    (name) =>
      `- ${name}: ${servers
        .filter((s) => s.name === name)
        .sort((a, b) => SESSION_BACKENDS.indexOf(a.backend) - SESSION_BACKENDS.indexOf(b.backend))
        .map(reachText)
        .join(', ')}`
  )
  const reachable = names.filter((name) =>
    servers.some(
      (s) => s.name === name && s.backend === mine && (!s.onlyIn || s.onlyIn === myFolder)
    )
  )
  return [
    ...lines,
    `You and your helpers run on ${BACKEND_LABEL[mine]}, so you can use: ${reachable.join(', ') || 'none of them'}.`
  ]
}
