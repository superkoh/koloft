import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { BackgroundFile } from '../../src/main/backgroundFile'

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-bgfile-'))
  file = path.join(dir, 'state.json')
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('BackgroundFile', () => {
  it('lands the newest of several quick writes, and leaves no temp file behind', async () => {
    const out = new BackgroundFile(() => file)
    for (let i = 1; i <= 5; i++) out.write(`v${i}`)
    await vi.waitFor(() => expect(fs.readFileSync(file, 'utf8')).toBe('v5'))
    expect(fs.readdirSync(dir)).toEqual(['state.json'])
  })

  it('a flush at quit puts the newest text on disk at once, and a slower earlier write never overwrites it', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const realWrite = fs.promises.writeFile
    vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(async (...args) => {
      await held
      return realWrite(...(args as Parameters<typeof realWrite>))
    })
    const out = new BackgroundFile(() => file)
    out.write('old')
    out.write('new')
    out.flushSync()
    expect(fs.readFileSync(file, 'utf8')).toBe('new')
    release()
    await vi.waitFor(() =>
      expect(fs.readdirSync(dir).filter((n) => n !== 'state.json')).toEqual([])
    )
    expect(fs.readFileSync(file, 'utf8')).toBe('new')
  })
})
