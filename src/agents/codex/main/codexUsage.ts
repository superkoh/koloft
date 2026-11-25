import path from 'path'
import { jsonlUnder } from '@agents/kit/main/usageFiles'
import { storedSessionsSearch, storedSessionsUsage } from '@agents/kit/main/storedUsage'
import type { AgentUsage, UsageFile, UsagePlaces } from '@core/agent/usage'
import type { AgentSearch } from '@core/agent/search'
import { CODEX_ROLLOUT_FOLDERS, mirrorCodexHome } from './codexMirror'

// CODEX§13
async function codexFiles({
  host,
  codexHome
}: {
  host?: string
  codexHome: string
}): Promise<UsageFile[]> {
  const found = await Promise.all(
    CODEX_ROLLOUT_FOLDERS.map((folder) => jsonlUnder(path.join(codexHome, folder), 'rollout-'))
  )
  return found.flat().map((file) => ({ file, backend: 'codex' as const, workspace: '', host }))
}

export function codexUsage(
  sessions: () => { usagePlaces(): UsagePlaces } | null,
  localHome: () => string,
  userData: () => string
): AgentUsage {
  return storedSessionsUsage(sessions, (machine) =>
    codexFiles(
      machine
        ? { host: machine, codexHome: mirrorCodexHome(userData(), machine) }
        : { codexHome: localHome() }
    )
  )
}

export function codexSearch(sessions: Parameters<typeof storedSessionsSearch>[0]): AgentSearch {
  return storedSessionsSearch(sessions)
}
