import os from 'os'
import path from 'path'
import type { McpServer } from '@shared/types'
import type { ListedModel } from '@shared/sessionPicks'
import type { AgentCatalog, AgentOneShot } from '@core/agent/agentsMain'
import { withSystemFirst, type ModelAndEffort } from '@core/assistModels'
import { textOrNull } from '../../../main/mcpServers'

// CODEX§15
const CODEX_ONE_SHOT = (launch: ModelAndEffort): string[] => [
  'exec',
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '-s',
  'read-only',
  ...(launch.model ? ['-m', launch.model] : []),
  ...(launch.effort ? ['-c', `model_reasoning_effort="${launch.effort}"`] : []),
  '-C',
  os.tmpdir(),
  '-'
]

// CODEX§15
export const codexOneShot: AgentOneShot = {
  argv: (_job, launch) => CODEX_ONE_SHOT(launch),
  stdin: withSystemFirst,
  answerFrom: (stdout) => stdout,
  sometimesAnswersLate: true,
  saysItHasNoSuchModel: /model is not supported/
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

export const codexCatalog = (
  sharedConfig: () => string,
  listedModels: () => Promise<ListedModel[] | undefined>
): AgentCatalog => ({
  // CODEX§15 CODEX§17
  moreSkillFoldersEveryAccountReadsOnThisMac: () => [
    path.join(path.dirname(sharedConfig()), 'skills')
  ],
  // CODEX§15
  mcpServersOn: async () => codexServers(await textOrNull(sharedConfig())),
  listedModels,
  oneShot: codexOneShot
})
