import path from 'path'
import type { BackendId } from '@shared/types'
import { shq } from '@shared/shellQuote'

// CC§10 CODEX§22 MUSE§1
const OFFICIAL_INSTALLER: Record<BackendId, string> = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  codex: 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh',
  muse: 'curl -fsSL https://dev.meta.ai/install.sh | bash'
}

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

export function installLine(backend: BackendId, testInstaller?: string): string {
  const run = testInstaller ? `${shq(testInstaller)} ${backend}` : OFFICIAL_INSTALLER[backend]
  return `${run}; [ -x "$HOME/.local/bin/${backend}" ] && exit`
}
