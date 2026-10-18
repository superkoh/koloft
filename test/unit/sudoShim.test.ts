import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { ASKPASS_NAME, writeSudoShims } from '../../src/main/sudoShim'

let base: string
let shimDir: string
let realDir: string
let log: string

function run(
  file: string,
  args: string[],
  env: Record<string, string> = {}
): Promise<{ status: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      env: { PATH: `${shimDir}:${realDir}:/usr/bin:/bin`, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    let stdout = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.on('close', (status) => resolve({ status: status ?? -1, stdout }))
  })
}

const logged = (): string[] => fs.readFileSync(log, 'utf8').trim().split('\n')

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-sudo-shim-')))
  shimDir = path.join(base, 'shim')
  realDir = path.join(base, 'real')
  log = path.join(base, 'calls.log')
  fs.mkdirSync(shimDir)
  fs.mkdirSync(realDir)
  writeSudoShims(shimDir)
  fs.writeFileSync(
    path.join(realDir, 'sudo'),
    `#!/bin/sh\necho "askpass=$SUDO_ASKPASS args=$*" >> '${log}'\n`,
    { mode: 0o755 }
  )
  fs.writeFileSync(
    path.join(shimDir, 'koloft'),
    `#!/bin/sh\nprintf '%s|' "$@" >> '${log}'\necho >> '${log}'\necho typed-password\n`,
    { mode: 0o755 }
  )
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe("Koloft's sudo in a session", () => {
  it('with no terminal it runs the real sudo with -A and Koloft’s password helper', async () => {
    await run(path.join(shimDir, 'sudo'), ['brew', 'services', 'restart', 'nginx'])
    expect(logged()).toEqual([
      `askpass=${path.join(shimDir, ASKPASS_NAME)} args=-A brew services restart nginx`
    ])
  })

  it('leaves sudo alone when the command reads its password itself, must not ask, or already has a helper', async () => {
    await run(path.join(shimDir, 'sudo'), ['-S', 'true'])
    await run(path.join(shimDir, 'sudo'), ['-n', 'true'])
    await run(path.join(shimDir, 'sudo'), ['true'], { SUDO_ASKPASS: '/own/helper' })
    expect(logged()).toEqual([
      'askpass= args=-S true',
      'askpass= args=-n true',
      'askpass=/own/helper args=true'
    ])
  })

  it('an option of the command itself is not taken for one of sudo’s', async () => {
    await run(path.join(shimDir, 'sudo'), ['sysctl', '-n', 'kern.hostname'])
    expect(logged()[0]).toMatch(/args=-A sysctl -n kern\.hostname$/)
  })

  it('the helper asks Koloft for the password with sudo’s prompt and the command that asked, and prints the answer for sudo', async () => {
    const r = await run(path.join(shimDir, ASKPASS_NAME), ['Password:'])
    expect(r.stdout).toBe('typed-password\n')
    const [secret, sudo, prompt, command] = logged()[0].split('|')
    expect([secret, sudo, prompt]).toEqual(['secret', 'sudo', 'Password:'])
    expect(command).not.toBe('')
  })
})
