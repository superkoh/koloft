import path from 'path'
import type { BackendId } from '@shared/types'
import { shq } from '@shared/shellQuote'
import { agentManifest } from '@core/agent/registry'

// CC§10
export function pathWithInstallDir(pathVar: string | undefined, home: string): string {
  const dirs = (pathVar ?? '').split(':').filter(Boolean)
  const installDir = path.join(home, '.local', 'bin')
  return (dirs.includes(installDir) ? dirs : [...dirs, installDir]).join(':')
}

export function pathWithDirFirst(pathVar: string | undefined, dir: string): string {
  return [dir, ...(pathVar ?? '').split(':').filter((d) => d && d !== dir)].join(':')
}

export function pathWithDirLast(pathVar: string | undefined, dir: string): string {
  return [...(pathVar ?? '').split(':').filter((d) => d && d !== dir), dir].join(':')
}

export function installThen(
  backend: BackendId,
  then: (binary: string) => string,
  testInstaller?: string
): string {
  const { command, installCommand } = agentManifest(backend)
  const run = testInstaller ? `${shq(testInstaller)} ${command}` : installCommand
  const binary = `"$HOME/.local/bin/${command}"`
  return `${run}; [ -x ${binary} ] && ${then(binary)}`
}
