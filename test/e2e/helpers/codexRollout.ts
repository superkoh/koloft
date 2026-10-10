import fs from 'fs'
import path from 'path'
import type { E2EEnv } from './env'

const ROLLOUT_THREAD_ID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

// CODEX§11
export function lastCodexTurnPermissions(env: E2EEnv, sessionId: string): Record<string, unknown> {
  const root = path.join(env.home, '.codex', 'sessions')
  const rollout = fs
    .readdirSync(root, { recursive: true, encoding: 'utf8' })
    .find((f) => sessionId.endsWith(ROLLOUT_THREAD_ID.exec(f)?.[1] ?? '-'))
  if (!rollout) return {}
  const turn = fs
    .readFileSync(path.join(root, rollout), 'utf8')
    .split('\n')
    .filter((line) => line.includes('"turn_context"'))
    .map(
      (line) =>
        JSON.parse(line) as {
          payload: { approval_policy?: unknown; sandbox_policy?: { type?: unknown } }
        }
    )
    .at(-1)?.payload
  return { approval: turn?.approval_policy, sandbox: turn?.sandbox_policy?.type }
}
