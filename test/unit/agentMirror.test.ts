import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { watchMirroredAgentRequests } from '../../src/main/remote/agentMirror'

const PULLS_OF_AN_UNCHANGED_REQUEST_SETTLE_MS = 1500

let stop: (() => void) | undefined
afterEach(() => stop?.())

describe('koloft requests the mirror brings back from a remote machine', () => {
  // PLATFORM§34
  it('answers a request once though every pull writes it again, and a new one by the same name only after a pull dropped the first', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-agent-mirror-'))
    const req = path.join(dir, 'req-a1.json')
    const answered: string[] = []
    stop = watchMirroredAgentRequests(dir, (id) => answered.push(id))
    const pull = (): void =>
      fs.writeFileSync(req, JSON.stringify({ tabId: 't', argv: ['session', 'new'], cwd: '/w' }))

    pull()
    await vi.waitFor(() => expect(answered).toEqual(['a1']), { timeout: 5000 })
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, PULLS_OF_AN_UNCHANGED_REQUEST_SETTLE_MS / 3))
      pull()
    }
    await new Promise((r) => setTimeout(r, PULLS_OF_AN_UNCHANGED_REQUEST_SETTLE_MS))
    expect(answered).toEqual(['a1'])

    fs.rmSync(req)
    await new Promise((r) => setTimeout(r, PULLS_OF_AN_UNCHANGED_REQUEST_SETTLE_MS))
    pull()
    await vi.waitFor(() => expect(answered).toEqual(['a1', 'a1']), { timeout: 5000 })
  })
})
