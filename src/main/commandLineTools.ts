import fs from 'fs'
import { execFile } from 'child_process'

const APPLE_INSTALLER = ['xcode-select', '--install']

// PLATFORM§1
export function commandLineToolsMissing(): Promise<boolean> {
  if (process.env.KOLOFT_TEST_CLT === 'missing') return Promise.resolve(true)
  return new Promise((resolve) =>
    execFile('xcode-select', ['-p'], (err) => resolve(!!err && typeof err.code === 'number'))
  )
}

export function installCommandLineTools(): void {
  const log = process.env.KOLOFT_EXTERNAL_OPENS_FILE
  if (log) fs.appendFile(log, `${APPLE_INSTALLER.join(' ')}\n`, () => {})
  if (process.env.KOLOFT_SUPPRESS_OS_OPEN) return
  execFile(APPLE_INSTALLER[0], APPLE_INSTALLER.slice(1), () => {})
}
