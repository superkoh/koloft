import { spawn } from 'child_process'
import os from 'os'

const A_KEY_SAVE_GIVES_UP_AFTER_MS = 30_000

export function pipeSecretTo(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
  secret: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: os.homedir(),
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: A_KEY_SAVE_GIVES_UP_AFTER_MS
    })
    let said = ''
    child.stderr.on('data', (chunk) => (said += String(chunk)))
    child.on('error', reject)
    child.stdin.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(said.trim() || `${args.join(' ')} failed`))
    )
    child.stdin.end(secret)
  })
}
