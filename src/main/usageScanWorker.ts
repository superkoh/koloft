import { parentPort, workerData } from 'worker_threads'
import { linesWithAny } from '@agents/kit/main/usageLines'
import { CLAUDE_USAGE_WORDS, scanClaudeCalls } from '@agents/claude/main/usageWorkerScan'
import { CODEX_USAGE_WORDS, scanCodexLines } from '@agents/codex/main/usageWorkerScan'
import { AGY_USAGE_WORDS, agyModels, scanAgyLines } from '@agents/agy/main/usageWorkerScan'
import type { ScannedFile, UsageFile } from './usageCache'

async function scan(f: UsageFile): Promise<Omit<ScannedFile, 'file'>> {
  const sessionId = f.sessionId ?? ''
  switch (f.backend) {
    case 'claude': {
      const { text, bornAt } = await linesWithAny(f.file, CLAUDE_USAGE_WORDS, true)
      return { records: [], claudeCalls: scanClaudeCalls(text), bornAt }
    }
    case 'agy': {
      const { calls, configured } = await agyModels(f.db)
      const { text } = await linesWithAny(f.file, AGY_USAGE_WORDS)
      return { records: scanAgyLines(text, sessionId, calls, configured) }
    }
    case 'codex': {
      const codex = scanCodexLines((await linesWithAny(f.file, CODEX_USAGE_WORDS)).text)
      return { records: codex?.records ?? [], cwd: codex?.cwd }
    }
  }
}

async function scanAll(files: UsageFile[]): Promise<void> {
  for (const f of files) {
    let scanned: Omit<ScannedFile, 'file'>
    try {
      scanned = await scan(f)
    } catch (error) {
      console.error('[koloft] usage read failed, retried next read:', f.file, error)
      continue
    }
    parentPort?.postMessage({ file: f.file, ...scanned })
  }
}

void scanAll((workerData as { files: UsageFile[] }).files)
