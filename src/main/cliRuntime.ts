import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { LoginShellError, readLoginShell } from './loginShell'

const exec = promisify(execFile)

export interface CliRuntime {
  binary: string
  env: NodeJS.ProcessEnv
  version: string
  verified: boolean
}

export interface CliSpec {
  command: string
  testCommandEnv: string
  name: string
  cliName: string
  notInstalled: string
  environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  version: RegExp
  testedLine: string
}

export async function resolveCliRuntime(
  spec: CliSpec,
  options: {
    env?: NodeJS.ProcessEnv
    shell?: string
    timeoutMs?: number
  } = {}
): Promise<CliRuntime> {
  const inherited = { ...(options.env ?? process.env) }
  const timeout = options.timeoutMs ?? 8000
  let binary = inherited.KOLOFT_TEST_BACKGROUND === '1' ? inherited[spec.testCommandEnv] : undefined
  let resolved = inherited
  if (!binary) {
    try {
      const login = await readLoginShell({
        shell: options.shell,
        env: inherited,
        timeoutMs: timeout,
        probe: `command -v ${spec.command}`
      })
      binary = login.probed
      resolved = login.env
    } catch (e) {
      throw new Error(
        e instanceof LoginShellError && e.reason === 'incomplete'
          ? `The shell did not return a complete ${spec.name} environment.`
          : `Could not load the shell environment for ${spec.name}. Check that your login shell starts successfully.`
      )
    }
  }
  if (!binary || !path.isAbsolute(binary)) throw new Error(spec.notInstalled)
  const env = spec.environment(resolved)
  let stdout: string
  try {
    stdout = (
      await exec(binary, ['--version'], { env, timeout, maxBuffer: 64 * 1024, encoding: 'utf8' })
    ).stdout
  } catch {
    throw new Error(`Could not run ${spec.cliName} from your shell environment.`)
  }
  const parsed = spec.version.exec(stdout)
  if (!parsed) throw new Error(`${spec.cliName} did not report a version Koloft understands.`)
  const [major, minor, patch] = parsed.slice(1, 4).map(Number)
  return {
    binary,
    env,
    version: `${major}.${minor}.${patch}`,
    verified: `${major}.${minor}` === spec.testedLine
  }
}
