import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { codexEnvironment } from './codexTransport'

const exec = promisify(execFile)

export interface CodexRuntime {
  binary: string
  env: NodeJS.ProcessEnv
  version: string
  // CODEX§7
  verified: boolean
}

export async function resolveCodexRuntime(
  options: {
    env?: NodeJS.ProcessEnv
    shell?: string
    timeoutMs?: number
  } = {}
): Promise<CodexRuntime> {
  const inherited = { ...(options.env ?? process.env) }
  const timeout = options.timeoutMs ?? 8000
  let binary = inherited.KOLOFT_TEST_BACKGROUND === '1' ? inherited.KOLOFT_CODEX_CMD : undefined
  let resolved = inherited
  if (!binary) {
    const token = randomUUID().replaceAll('-', '')
    const begin = `\0KOLOFT_CODEX_BEGIN_${token}\0`
    const end = `\0KOLOFT_CODEX_END_${token}\0`
    const script = `printf '\\000KOLOFT_CODEX_BEGIN_${token}\\000'; command -v codex; printf '\\000'; /usr/bin/env -0; printf '\\000KOLOFT_CODEX_END_${token}\\000'`
    let stdout: string
    try {
      const result = await exec(
        options.shell ?? inherited.SHELL ?? os.userInfo().shell ?? '/bin/zsh',
        ['-l', '-i', '-c', script],
        {
          env: inherited,
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          encoding: 'utf8'
        }
      )
      stdout = result.stdout
    } catch {
      throw new Error(
        'Could not load the shell environment for Codex. Check that your login shell starts successfully.'
      )
    }
    const start = stdout.indexOf(begin)
    const finish = stdout.indexOf(end, start + begin.length)
    if (start === -1 || finish === -1)
      throw new Error('The shell did not return a complete Codex environment.')
    const fields = stdout.slice(start + begin.length, finish).split('\0')
    binary = fields.shift()?.trim()
    resolved = Object.fromEntries(Object.keys(inherited).map((key) => [key, undefined]))
    for (const field of fields) {
      const equal = field.indexOf('=')
      if (equal > 0) resolved[field.slice(0, equal)] = field.slice(equal + 1)
    }
  }
  if (!binary || !path.isAbsolute(binary)) {
    throw new Error('Install Codex CLI 0.153.4 or newer to start Codex sessions.')
  }
  const env = codexEnvironment(resolved)
  let stdout: string
  try {
    stdout = (
      await exec(binary, ['--version'], { env, timeout, maxBuffer: 64 * 1024, encoding: 'utf8' })
    ).stdout
  } catch {
    throw new Error('Could not run Codex CLI from your shell environment.')
  }
  const parsed = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(stdout)
  if (!parsed) throw new Error('Codex CLI did not report a version Koloft understands.')
  const [major, minor, patch] = parsed.slice(1, 4).map(Number)
  if (major === 0 && (minor < 153 || (minor === 153 && patch < 4))) {
    throw new Error('Koloft needs Codex CLI 0.153.4 or newer. Update Codex to start a session.')
  }
  return {
    binary,
    env,
    version: `${major}.${minor}.${patch}`,
    verified: major === 0 && minor === 153
  }
}
