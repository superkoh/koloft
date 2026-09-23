import os from 'os'

/**
 * The shell a session runs in: login + interactive, so the user's profile (PATH, aliases,
 * shell functions) loads. Anything that asks "is this tool installed?" must ask this
 * same shell — a `zsh -lc` skips ~/.zshrc and said "no claude" of one every session found.
 */
export function userShell(env: NodeJS.ProcessEnv = process.env): {
  shell: string
  args: string[]
} {
  const isWin = os.platform() === 'win32'
  return {
    shell: env.SHELL || (isWin ? 'powershell.exe' : '/bin/zsh'),
    args: isWin ? [] : ['-l', '-i']
  }
}
