import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runningClaudePid } from '../../src/main/claudeSessionRegistry'

const SID = '1425a153-9a1b-45b1-a727-b05f5a9c490e'
const START = 'Wed Sep 23 20:29:08 2026'

let dir: string

function entry(pid: number, sessionId: string, procStart = START): void {
  fs.writeFileSync(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, procStart, kind: 'interactive' })
  )
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-ccreg-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

// CC§11
describe("claude's own session registry: is this session still running somewhere?", () => {
  it('finds the live claude that holds the session', async () => {
    entry(29948, SID)
    expect(await runningClaudePid(SID, dir, async () => START)).toBe(29948)
  })

  it('a hard-killed claude leaves its entry behind: a dead pid is not running', async () => {
    entry(92355, SID)
    expect(await runningClaudePid(SID, dir, async () => null)).toBeNull()
  })

  it('a pid now owned by another process is not the session', async () => {
    entry(92355, SID)
    expect(await runningClaudePid(SID, dir, async () => 'Thu Sep 24 08:00:00 2026')).toBeNull()
  })

  it('after /clear the entry names the new id, so the old one is free to resume', async () => {
    entry(29948, '424b6fd0-a45c-489b-a221-8346f11d37ed')
    expect(await runningClaudePid(SID, dir, async () => START)).toBeNull()
  })

  it('no registry directory means nothing is running', async () => {
    expect(await runningClaudePid(SID, path.join(dir, 'missing'), async () => START)).toBeNull()
  })
})
