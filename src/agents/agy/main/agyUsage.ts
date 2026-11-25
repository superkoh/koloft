import fs from 'fs'
import path from 'path'
import { AGY_APP_DIR, agyTranscript, conversationDb } from './agyStore'
import type { UsageFile, UsageHome } from '../../../main/usageCache'

// AGY§8
export async function agyFiles({ host, geminiDir }: UsageHome): Promise<UsageFile[]> {
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
