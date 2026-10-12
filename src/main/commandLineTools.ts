import { execFileSync } from 'child_process'

const APPLE_GIT_STUB_DIR = '/usr/bin'
const USUAL_OTHER_GIT_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']

// PLATFORM§1
export function dirsAnotherGitMayBeIn(pathVar: string | undefined): string[] {
  const onPath = (pathVar ?? '').split(':').filter((d) => d && d !== APPLE_GIT_STUB_DIR)
  return process.env.KOLOFT_TEST_CLT === 'missing' ? onPath : [...onPath, ...USUAL_OTHER_GIT_DIRS]
}

// PLATFORM§1
export function commandLineToolsMissing(): boolean {
  if (process.env.KOLOFT_TEST_CLT === 'missing') return true
  try {
    execFileSync('xcode-select', ['-p'], { stdio: 'ignore' })
    return false
  } catch (err) {
    return typeof (err as { status?: unknown }).status === 'number'
  }
}
