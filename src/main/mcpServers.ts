import type { BackendId } from '@shared/types'
import { BACKEND_LABEL, SESSION_BACKENDS } from '@shared/sessionBackend'

export interface McpServer {
  name: string
  backend: BackendId
  onlyIn?: string
}

function namesIn(raw: unknown): string[] {
  return Object.keys(asRecord(raw))
}

export const CLAUDE_PROJECT_MCP_FILE = '.mcp.json'

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

export function claudeServers(
  claudeJson: string | null,
  projectFiles: { folder: string; text: string | null }[]
): McpServer[] {
  const doc = parsed(claudeJson)
  const projects = asRecord(doc.projects)
  return [
    ...namesIn(doc.mcpServers).map((name) => ({ name, backend: 'claude' as const })),
    ...Object.entries(projects).flatMap(([folder, p]) =>
      namesIn(asRecord(p).mcpServers).map((name) => ({
        name,
        backend: 'claude' as const,
        onlyIn: folder
      }))
    ),
    ...projectFiles.flatMap(({ folder, text }) =>
      namesIn(parsed(text).mcpServers).map((name) => ({
        name,
        backend: 'claude' as const,
        onlyIn: folder
      }))
    )
  ]
}

const CODEX_SERVER_TABLE = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]/gm

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
