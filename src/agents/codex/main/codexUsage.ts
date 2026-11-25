import path from 'path'
import { jsonlUnder } from '@agents/kit/main/usageFiles'
import type { UsageFile, UsageHome } from '../../../main/usageCache'

export const CODEX_ROLLOUT_FOLDERS = ['sessions', 'archived_sessions']

// CODEX§13
export async function codexFiles({ host, codexHome }: UsageHome): Promise<UsageFile[]> {
  const found = await Promise.all(
    CODEX_ROLLOUT_FOLDERS.map((folder) => jsonlUnder(path.join(codexHome, folder), 'rollout-'))
  )
  return found.flat().map((file) => ({ file, backend: 'codex' as const, workspace: '', host }))
}
