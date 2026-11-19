import { execFile } from 'child_process'
import { promisify } from 'util'
import type { GhResult } from '@core/gh'
import { FETCH_TIMEOUT_MS } from './gitFreshness'

const GH_MAX_BUFFER = 64 * 1024 * 1024
const GH_READ_MAX_BUFFER = 16 * 1024 * 1024

export function runGh(args: string[], env?: NodeJS.ProcessEnv): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      { timeout: FETCH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, ...(env && { env }) },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code
        resolve({
          code: !err ? 0 : typeof code === 'number' ? code : null,
          stdout: String(stdout),
          stderr: String(stderr),
          missing: code === 'ENOENT'
        })
      }
    )
  })
}

export async function ghRead(
  args: string[],
  env?: NodeJS.ProcessEnv,
  cwd?: string
): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await promisify(execFile)('gh', args, {
      timeout: FETCH_TIMEOUT_MS,
      maxBuffer: GH_READ_MAX_BUFFER,
      ...(env && { env }),
      ...(cwd && { cwd })
    })
    return { ok: true, out: stdout }
  } catch (error) {
    const e = error as Error & { stderr?: string }
    return { ok: false, out: e.stderr?.trim() || e.message }
  }
}
