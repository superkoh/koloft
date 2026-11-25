import fs from 'fs'
import path from 'path'
import { storedSessionsSearch, storedSessionsUsage } from '@agents/kit/main/storedUsage'
import type { AgentUsage, UsageFile, UsagePlaces } from '@core/agent/usage'
import type { AgentSearch } from '@core/agent/search'
import { AGY_APP_DIR, agyTranscript, conversationDb } from './agyStore'
import { mirrorAgyGemini } from './agyMirror'

// AGY§8
async function agyFiles({
  host,
  geminiDir
}: {
  host?: string
  geminiDir: string
}): Promise<UsageFile[]> {
  let ids: string[]
  try {
    ids = await fs.promises.readdir(path.join(geminiDir, AGY_APP_DIR, 'brain'))
  } catch {
    return []
  }
  return ids.map((id) => ({
    file: agyTranscript(geminiDir, id),
    backend: 'agy' as const,
    workspace: '',
    sessionId: id,
    db: conversationDb(geminiDir, id),
    host
  }))
}

export function agyUsage(
  sessions: () => { usagePlaces(): UsagePlaces } | null,
  localGemini: () => string,
  userData: () => string
): AgentUsage {
  return storedSessionsUsage(sessions, (machine) =>
    agyFiles(
      machine
        ? { host: machine, geminiDir: mirrorAgyGemini(userData(), machine) }
        : { geminiDir: localGemini() }
    )
  )
}

export function agySearch(sessions: Parameters<typeof storedSessionsSearch>[0]): AgentSearch {
  return storedSessionsSearch(sessions)
}
