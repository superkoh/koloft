import { execFile } from 'child_process'

const NOTHING_IGNORED_EXIT = 1

// PLATFORM§30
export function gitIgnoredAmong(root: string, paths: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', root, 'check-ignore', '-z', '--stdin'],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error && error.code !== NOTHING_IGNORED_EXIT) reject(error)
        else resolve(stdout.split('\0').filter(Boolean))
      }
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(paths.map((p) => p + '\0').join(''))
  })
}
