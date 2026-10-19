import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startToolShim } from '../../src/main/toolShim'
import { ownedByThisRun } from '../../src/main/leftovers'

describe('tool shim folders left by a Koloft run that has ended', () => {
  it('are removed when a tab of any agent next starts its tool shim in that folder; a live run’s folder is kept', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-shims-'))
    const ended = `${spawnSync('true').pid}-${randomUUID()}`
    const live = ownedByThisRun(randomUUID())
    fs.mkdirSync(path.join(root, ended))
    fs.mkdirSync(path.join(root, live))

    const tool = startToolShim(
      { openShimRoot: root, playwrightBin: root, ghWrapper: path.join(root, 'gh') },
      { open: () => {} }
    )
    try {
      const names = fs.readdirSync(root)
      expect(names).not.toContain(ended)
      expect(names).toContain(live)
    } finally {
      tool.release()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
