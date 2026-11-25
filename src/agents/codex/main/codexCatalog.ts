import type { McpServer } from '@shared/types'
import type { AgentCatalog } from '@core/agent/agentsMain'
import { textOrNull } from '../../../main/mcpServers'

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

export const codexCatalog = (sharedConfig: () => string): AgentCatalog => ({
  // CODEX§15
  mcpServersOn: async () => codexServers(await textOrNull(sharedConfig()))
})
