import { execFile } from 'child_process'
import { promisify } from 'util'
import { codexEnvironment } from './codexTransport'
import { resolveCliRuntime, type CliRuntime, type CliSpec } from './cliRuntime'
import { MIN_CODEX_VERSION, TESTED_CODEX_LINE } from './cliMinimums'
import { isNewer } from './releaseNotes'

const exec = promisify(execFile)

export type CodexRuntime = CliRuntime

const CODEX: CliSpec = {
  command: 'codex',
  testCommandEnv: 'KOLOFT_CODEX_CMD',
  name: 'Codex',
  cliName: 'Codex CLI',
  notInstalled: `Install Codex CLI ${MIN_CODEX_VERSION} or newer to start Codex sessions.`,
  environment: (env) => codexEnvironment(env),
  version: /codex-cli (\d+)\.(\d+)\.(\d+)/,
  // CODEX§7
  testedLine: TESTED_CODEX_LINE
}

export function resolveCodexRuntime(
  options: { env?: NodeJS.ProcessEnv; shell?: string; timeoutMs?: number } = {}
): Promise<CodexRuntime> {
  return resolveCliRuntime(CODEX, options)
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
