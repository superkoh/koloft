import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import os from 'os'
import { promisify } from 'util'

const exec = promisify(execFile)
const LOGIN_SHELL_TIMEOUT_MS = 8000

export class LoginShellError extends Error {
  constructor(readonly reason: 'failed' | 'incomplete') {
    super(reason)
  }
}

// PLATFORM§2
export async function readLoginShell(opts: {
  env: NodeJS.ProcessEnv
  shell?: string
  timeoutMs?: number
  probe?: string
}): Promise<{ probed: string; env: NodeJS.ProcessEnv }> {
  const token = randomUUID().replaceAll('-', '')
  const begin = `\0KOLOFT_LOGIN_BEGIN_${token}\0`
  const end = `\0KOLOFT_LOGIN_END_${token}\0`
  const script = `printf '\\000KOLOFT_LOGIN_BEGIN_${token}\\000'; ${opts.probe ?? ':'}; printf '\\000'; /usr/bin/env -0; printf '\\000KOLOFT_LOGIN_END_${token}\\000'`
  let stdout: string
  try {
    stdout = (
      await exec(
        opts.shell ?? (opts.env.SHELL || os.userInfo().shell || '/bin/zsh'),
        ['-l', '-i', '-c', script],
        {
          env: opts.env,
          timeout: opts.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
          encoding: 'utf8'
        }
      )
    ).stdout
  } catch {
    throw new LoginShellError('failed')
  }
  const start = stdout.indexOf(begin)
  const finish = stdout.indexOf(end, start + begin.length)
  if (start === -1 || finish === -1) throw new LoginShellError('incomplete')
  const fields = stdout.slice(start + begin.length, finish).split('\0')
  const probed = fields.shift()?.trim() ?? ''
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.keys(opts.env).map((key) => [key, undefined])
  )
  for (const field of fields) {
    const equal = field.indexOf('=')
    if (equal > 0) env[field.slice(0, equal)] = field.slice(equal + 1)
  }
  return { probed, env }
}

// PLATFORM§1
export function sshEnvFromLogin(
  current: NodeJS.ProcessEnv,
  login: NodeJS.ProcessEnv
): { PATH?: string; SSH_AUTH_SOCK?: string } {
  const have = (current.PATH ?? '').split(':').filter(Boolean)
  const added = (login.PATH ?? '').split(':').filter((d) => d && !have.includes(d))
  return {
    ...(added.length ? { PATH: [...have, ...new Set(added)].join(':') } : {}),
    ...(login.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: login.SSH_AUTH_SOCK } : {})
  }
}
