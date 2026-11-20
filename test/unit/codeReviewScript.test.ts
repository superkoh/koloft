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

function fakeClaudeAnswering(result: string): string {
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-codereview-bin-')))
  createdDirs.push(bin)
  const line = JSON.stringify({ type: 'result', is_error: false, num_turns: 0, result })
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' '${line}'\nexit 0\n`, {
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
  it('counts a review whose model call failed as failed, though claude exits 0 with is_error false', () => {
    const r = runScript(fakeClaudeAnswering('API Error: Connection refused (ECONNREFUSED)'))
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('0 of 3 reviews finished.')
  })

  it('counts a review that came back with findings as finished', () => {
    const r = runScript(fakeClaudeAnswering('```json\n[]\n```'))
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('3 of 3 reviews finished.')
  })
})
