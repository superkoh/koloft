import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendId } from '../../src/shared/types'
import { DEFAULT_SETTINGS } from '../../src/shared/settingsOps'
import { EVERY_AGENTS_ONE_SHOT } from './helpers/agentOneShots'

const GONE_WITHIN_MS = 3_000
const BACKENDS: BackendId[] = ['claude', 'codex', 'agy']

type Modules = {
  quit: typeof import('../../src/main/oneShotsAtQuit')
  assist: typeof import('../../src/main/assist')
  agy: typeof import('../../src/agents/agy/main/agyAccounts')
}

let mods: Modules
const started: number[] = []
let dir: string

beforeEach(async () => {
  vi.resetModules()
  mods = {
    quit: await import('../../src/main/oneShotsAtQuit'),
    assist: await import('../../src/main/assist'),
    agy: await import('../../src/agents/agy/main/agyAccounts')
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-one-shot-quit-'))
})

afterEach(() => {
  const written = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.pid'))
    .map((f) => Number(fs.readFileSync(path.join(dir, f), 'utf8').trim()))
  for (const pid of [...started.splice(0), ...written]) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

function longRunningBinary(name: string): { bin: string; pidFile: string } {
  const bin = path.join(dir, name)
  const pidFile = path.join(dir, `${name}.pid`)
  fs.writeFileSync(bin, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nexec sleep 600\n`, {
    mode: 0o755
  })
  return { bin, pidFile }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return check()
}

async function runningPid(pidFile: string): Promise<number> {
  expect(
    await until(
      () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '',
      GONE_WITHIN_MS
    )
  ).toBe(true)
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
  started.push(pid)
  expect(alive(pid)).toBe(true)
  return pid
}

function assistOn(backend: BackendId, binary: string, targets: BackendId[] = []) {
  return mods.assist.koloftAssist({
    picks: () => ({
      assist: { backend },
      sessionMethods: DEFAULT_SETTINGS.sessionMethods,
      accounts: []
    }),
    enabled: () => true,
    oneShot: (b) => EVERY_AGENTS_ONE_SHOT[b],
    target: async (b) => {
      targets.push(b)
      return b === backend ? { binary, env: {}, done: () => {} } : null
    },
    onThisAccount: async (_b, asked) => asked
  })
}

const JOB = { row: 'title' as const, system: 'You write short titles.', prompt: 'Task:\nfix it' }

describe('one-shot commands when Koloft quits', () => {
  for (const backend of BACKENDS) {
    it(`stops a ${backend} Assist one-shot still running when Koloft quits`, async () => {
      const fake = longRunningBinary(backend)
      const answer = assistOn(backend, fake.bin)(JOB)
      const pid = await runningPid(fake.pidFile)
      mods.quit.endOneShots()
      expect(await until(() => !alive(pid), GONE_WITHIN_MS)).toBe(true)
      expect(await answer).toBeNull()
    })
  }

  it('stops the Antigravity model list and usage reads still running when Koloft quits', async () => {
    const models = longRunningBinary('agy-models')
    const quota = longRunningBinary('agy-usage')
    const listed = mods.agy.readAgyModels(models.bin, {}, [])
    const usage = mods.agy.readAgyQuota(quota.bin, {}, dir)
    const pids = [await runningPid(models.pidFile), await runningPid(quota.pidFile)]
    mods.quit.endOneShots()
    expect(await until(() => pids.every((p) => !alive(p)), GONE_WITHIN_MS)).toBe(true)
    expect(await listed).toBeUndefined()
    expect(await usage).toBeUndefined()
  })

  it('starts no one-shot and makes no target for it once Koloft quits', async () => {
    const fake = longRunningBinary('claude')
    const targets: BackendId[] = []
    mods.quit.endOneShots()
    expect(await assistOn('claude', fake.bin, targets)(JOB)).toBeNull()
    expect(targets).toEqual([])
    expect(await mods.agy.readAgyModels(fake.bin, {}, [])).toBeUndefined()
    expect(fs.existsSync(fake.pidFile)).toBe(false)
  })
})
