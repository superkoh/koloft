import fs from 'fs'
import path from 'path'

const ASSIST_MEMORY = `# Assist memory

This file is your memory folder. When the owner asks you to remember something, add it here as one short line. Keep everything already here.
`

// CODEX§17 AGY§32
export function seedAssistMemory(folder: string): void {
  try {
    fs.writeFileSync(path.join(folder, 'AGENTS.md'), ASSIST_MEMORY, { flag: 'wx' })
  } catch {}
}
