import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { releaseLock, takeLock } from '../../src/main/discord/instanceLock'

const OTHER_PID = 424242
const BOOT_BEFORE_A_REBOOT_S = 1_000_000

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-discord-lock-'))
  file = path.join(dir, 'discord.lock')
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function bootNow(): number {
  return Math.round(Date.now() / 1000 - os.uptime())
}

describe('Discord instance lock', () => {
  it('only one Koloft per userData holds it while the holder lives, and it frees on release', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: OTHER_PID, boot: bootNow() }))
    expect(takeLock(file, () => true)).toBe(false)
    expect(takeLock(file, () => false)).toBe(true)
    releaseLock(file)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('a lock left from before a reboot is stale even if its pid is alive now', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: OTHER_PID, boot: BOOT_BEFORE_A_REBOOT_S }))
    expect(takeLock(file, () => true)).toBe(true)
  })

  it('release leaves a lock another instance holds', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: OTHER_PID, boot: bootNow() }))
    releaseLock(file)
    expect(fs.existsSync(file)).toBe(true)
  })
})
