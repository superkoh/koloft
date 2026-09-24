import fs from 'fs'
import os from 'os'
import path from 'path'

export function codexConfigFile(env: NodeJS.ProcessEnv | undefined): string {
  return path.join(env?.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')
}

// CODEX§11 ADR-0026
export function acceptCodexTrust(configFile: string, dir: string): void {
  let text = ''
  try {
    text = fs.readFileSync(configFile, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const header = `[projects.${JSON.stringify(fs.realpathSync(dir))}]`
  if (text.split(/\r?\n/).some((line) => line.trim() === header)) return
  const gap = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  const tmp = `${configFile}.koloft-${process.pid}`
  fs.writeFileSync(tmp, `${text}${gap}${header}\ntrust_level = "trusted"\n`, { mode: 0o600 })
  fs.renameSync(tmp, configFile)
}
