import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { codexEnvironment } from './codexTransport'
import { LoginShellError, readLoginShell } from './loginShell'
import { MIN_CODEX_VERSION, TESTED_CODEX_LINE } from './cliMinimums'
import { isNewer } from './releaseNotes'

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
    try {
      const login = await readLoginShell({
        shell: options.shell,
        env: inherited,
        timeoutMs: timeout,
        probe: 'command -v codex'
      })
      binary = login.probed
      resolved = login.env
    } catch (e) {
      throw new Error(
        e instanceof LoginShellError && e.reason === 'incomplete'
          ? 'The shell did not return a complete Codex environment.'
          : 'Could not load the shell environment for Codex. Check that your login shell starts successfully.'
      )
    }
  }
  if (!binary || !path.isAbsolute(binary)) {
    throw new Error(`Install Codex CLI ${MIN_CODEX_VERSION} or newer to start Codex sessions.`)
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
  return {
    binary,
    env,
    version: `${major}.${minor}.${patch}`,
    verified: `${major}.${minor}` === TESTED_CODEX_LINE
  }
}

export const codexTooOld = (runtime: CodexRuntime): boolean =>
  isNewer(MIN_CODEX_VERSION, runtime.version)

const CODEX_UPDATE_TIMEOUT_MS = 5 * 60_000

// CODEX§22
export async function updateCodex(runtime: CodexRuntime): Promise<void> {
  await exec(runtime.binary, ['update'], {
    env: runtime.env,
    timeout: CODEX_UPDATE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  }).catch(() => undefined)
}
