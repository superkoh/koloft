import fs from 'fs'
import os from 'os'
import path from 'path'
import { writePrivateAtomically } from './privateFile'

export function codexConfigFile(env: NodeJS.ProcessEnv | undefined): string {
  return path.join(env?.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')
}

const projectHeader = (dir: string): string => `[projects.${JSON.stringify(fs.realpathSync(dir))}]`

// CODEX§11 ADR-0026
export function acceptCodexTrust(configFile: string, dir: string): void {
  let text = ''
  try {
    text = fs.readFileSync(configFile, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const header = projectHeader(dir)
  if (text.split(/\r?\n/).some((line) => line.trim() === header)) return
  const gap = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  writePrivateAtomically(configFile, `${text}${gap}${header}\ntrust_level = "trusted"\n`)
}

// CODEX§11
export function codexTrustsFolder(configFile: string, dir: string): boolean {
  let text: string
  let header: string
  try {
    text = fs.readFileSync(configFile, 'utf8')
    header = projectHeader(dir)
  } catch {
    return false
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const start = lines.indexOf(header)
  if (start < 0) return false
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('[')) return false
    if (/^trust_level\s*=\s*"trusted"$/.test(line)) return true
  }
  return false
}
