import fs from 'fs'
import os from 'os'
import path from 'path'
import { writePrivateAtomically } from './privateFile'
import { realpathSafe } from './projectInfo'

export function codexConfigFile(env: NodeJS.ProcessEnv | undefined): string {
  return path.join(env?.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')
}

const projectHeader = (dir: string): string => `[projects.${JSON.stringify(fs.realpathSync(dir))}]`

const hookStateHeader = (key: string): string => `[hooks.state.${JSON.stringify(key)}]`

function readConfig(configFile: string): string {
  try {
    return fs.readFileSync(configFile, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return ''
  }
}

// CODEX§15 PLATFORM§43
function writeConfig(configFile: string, text: string): void {
  const target = realpathSafe(configFile)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  writePrivateAtomically(target, text)
}

function appendTable(text: string, table: string): string {
  const gap = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return `${text}${gap}${table}`
}

// CODEX§11 ADR-0026
export function acceptCodexTrust(configFile: string, dir: string): void {
  const text = readConfig(configFile)
  const header = projectHeader(dir)
  if (text.split(/\r?\n/).some((line) => line.trim() === header)) return
  writeConfig(configFile, appendTable(text, `${header}\ntrust_level = "trusted"\n`))
}

// CODEX§27
export function codexHookTrusted(configFile: string, key: string, hash: string): boolean {
  const lines = readConfig(configFile).split('\n')
  const start = lines.findIndex((line) => line.trim() === hookStateHeader(key))
  if (start < 0) return false
  const trusted = `trusted_hash = ${JSON.stringify(hash)}`
  for (let i = start + 1; i < lines.length && !lines[i].trim().startsWith('['); i++)
    if (lines[i].trim() === trusted) return true
  return false
}

export function acceptCodexHookTrust(configFile: string, key: string, hash: string): void {
  const header = hookStateHeader(key)
  const trusted = `trusted_hash = ${JSON.stringify(hash)}`
  const lines = readConfig(configFile).split('\n')
  const start = lines.findIndex((line) => line.trim() === header)
  if (start < 0) {
    writeConfig(configFile, appendTable(lines.join('\n'), `${header}\n${trusted}\n`))
    return
  }
  let end = start + 1
  while (end < lines.length && !lines[end].trim().startsWith('[')) end++
  const body = lines.slice(start + 1, end).filter((line) => !/^\s*trusted_hash\s*=/.test(line))
  lines.splice(start, end - start, header, trusted, ...body)
  writeConfig(configFile, lines.join('\n'))
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
