import os from 'os'

// PLATFORM§2
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
