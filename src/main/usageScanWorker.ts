import fs from 'fs'
import readline from 'readline'
import { parentPort, workerData } from 'worker_threads'
import { CLAUDE_USAGE_WORDS, CODEX_USAGE_WORDS, scanClaudeLines, scanCodexLines } from './usageScan'
import type { ScannedFile, UsageFile } from './usageCache'

async function linesWithAny(file: string, words: string[]): Promise<string> {
  const kept: string[] = []
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) if (words.some((w) => line.includes(w))) kept.push(line)
  return kept.join('\n')
}

async function scan(f: UsageFile): Promise<ScannedFile> {
  if (f.backend === 'claude') {
    return {
      file: f.file,
      records: scanClaudeLines(await linesWithAny(f.file, CLAUDE_USAGE_WORDS))
    }
  }
  const codex = scanCodexLines(await linesWithAny(f.file, CODEX_USAGE_WORDS))
  return { file: f.file, records: codex?.records ?? [], cwd: codex?.cwd }
}

async function scanAll(files: UsageFile[]): Promise<void> {
  for (const f of files) {
    try {
      parentPort?.postMessage(await scan(f))
    } catch {
      continue
    }
  }
}

void scanAll((workerData as { files: UsageFile[] }).files)
