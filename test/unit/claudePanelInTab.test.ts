import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const SID = '1425a153-9a1b-45b1-a727-b05f5a9c490e'
const HOST = 'devbox'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-ccpanel-'))
const realHome = process.env.HOME
let inTab: typeof import('../../src/agents/claude/main/claudeSessionRegistry').claudeShowsAPanelInTab

const onMachine = (status: string): string =>
  JSON.stringify({ pid: 1, sessionId: SID, kind: 'interactive', status }) + '\0'

function liveEntryHere(status: string): void {
  const sessions = path.join(home, '.claude', 'sessions')
  fs.mkdirSync(sessions, { recursive: true })
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
    env: { ...process.env, TZ: 'UTC' }
  })
    .toString()
    .trim()
  fs.writeFileSync(
    path.join(sessions, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: SID, procStart, status })
  )
}

beforeAll(async () => {
  process.env.HOME = home
  inTab = (await import('../../src/agents/claude/main/claudeSessionRegistry'))
    .claudeShowsAPanelInTab
})

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(home, { recursive: true, force: true })
})

// CC§11
describe('whether a Claude Code tab shows a panel, read from its own session registry', () => {
  it('cannot say before the tab has a session, and asks no machine', async () => {
    const asked: string[] = []
    const places = {
      remoteHostOf: () => HOST,
      liveRegistryOn: async (host: string) => (asked.push(host), onMachine('waiting'))
    }
    expect(await inTab('tab-1', '', places)).toBeUndefined()
    expect(asked).toEqual([])
  })

  it('on this Mac reads the registry in the home folder, and no machine', async () => {
    const asked: string[] = []
    const places = {
      remoteHostOf: () => undefined,
      liveRegistryOn: async (host: string) => (asked.push(host), onMachine('idle'))
    }
    expect(await inTab('tab-1', SID, places)).toBeUndefined()
    liveEntryHere('waiting')
    expect(await inTab('tab-1', SID, places)).toBe(true)
    liveEntryHere('idle')
    expect(await inTab('tab-1', SID, places)).toBe(false)
    expect(asked).toEqual([])
  })

  it('on a machine reads that machine’s registry for this tab, and cannot say when reading it fails', async () => {
    const asked: string[] = []
    let registry = onMachine('waiting')
    const places = {
      remoteHostOf: (tab: string) => (tab === 'tab-1' ? HOST : undefined),
      liveRegistryOn: async (host: string) => (asked.push(host), registry)
    }
    expect(await inTab('tab-1', SID, places)).toBe(true)
    registry = onMachine('idle')
    expect(await inTab('tab-1', SID, places)).toBe(false)
    expect(asked).toEqual([HOST, HOST])
    const failing = {
      remoteHostOf: () => HOST,
      liveRegistryOn: async () => Promise.reject(new Error('ssh: connect refused'))
    }
    expect(await inTab('tab-1', SID, failing)).toBeUndefined()
  })
})
