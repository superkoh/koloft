import { execFile } from 'child_process'
import { osHandOffSuppressed } from './osOpen'

const APPLE_INSTALLER = ['xcode-select', '--install']

// PLATFORM§1
export function commandLineToolsMissing(): Promise<boolean> {
  if (process.env.KOLOFT_TEST_CLT === 'missing') return Promise.resolve(true)
  return new Promise((resolve) =>
    execFile('xcode-select', ['-p'], (err) => resolve(!!err && typeof err.code === 'number'))
  )
}

export function installCommandLineTools(): void {
  if (osHandOffSuppressed(APPLE_INSTALLER.join(' '))) return
  execFile(APPLE_INSTALLER[0], APPLE_INSTALLER.slice(1), () => {})
}
