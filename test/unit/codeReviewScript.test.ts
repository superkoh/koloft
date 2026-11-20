import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const script = path.resolve(__dirname, '../../scripts/code-review.mjs')

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function fakeClaudeAnswering(result: string, exitCode = 0): string {
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-codereview-bin-')))
  createdDirs.push(bin)
  const answer = path.join(bin, 'answer.json')
  fs.writeFileSync(
    answer,
    JSON.stringify({ type: 'result', is_error: false, num_turns: 0, result })
  )
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncat "${answer}"\nexit ${exitCode}\n`, {
    mode: 0o755
  })
  return bin
}

function runScript(bin: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script, 'origin/main...HEAD'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
  })
}

describe('scripts/code-review.mjs', () => {
  it.each([
    ['a failed model call', 'API Error: Connection refused (ECONNREFUSED)', 0],
    ['a sign-in that failed', "Failed to authenticate. API Error: 401 OAuth token isn't valid", 1]
  ])(
    'counts a run whose answer is %s as failed, though claude reports is_error false',
    (_, answer, exitCode) => {
      const r = runScript(fakeClaudeAnswering(answer, exitCode))
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('0 of 3 reviews finished.')
    }
  )

  it('counts a run whose answer holds the findings block as finished, an empty one too', () => {
    const r = runScript(fakeClaudeAnswering('```json\n[]\n```'))
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('3 of 3 reviews finished.')
  })
})
