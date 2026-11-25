import type { UsageHome } from '../usageCache'
import { mirrorCodexHome } from '@agents/codex/main/codexMirror'
import { mirrorAgyGemini } from '@agents/agy/main/agyMirror'

export function machineUsageDirs(userData: string, host: string): UsageHome {
  return {
    host,
    codexHome: mirrorCodexHome(userData, host),
    geminiDir: mirrorAgyGemini(userData, host)
  }
}
