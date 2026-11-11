import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { BackgroundFile, FOLDER_OF_HALF_WRITTEN_FILES } from '../../src/main/backgroundFile'

let dir: string
let file: string

function halfWrittenFilesLeft(): string[] {
  return fs.readdirSync(path.join(dir, FOLDER_OF_HALF_WRITTEN_FILES))
}

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
    expect(fs.readdirSync(dir).sort()).toEqual([FOLDER_OF_HALF_WRITTEN_FILES, 'state.json'])
    expect(halfWrittenFilesLeft()).toEqual([])
  })

  it('never creates a file in the folder of the file it saves, so a slow disk holds up no lookup there', async () => {
    const created: string[] = []
    const realWrite = fs.promises.writeFile
    vi.spyOn(fs.promises, 'writeFile').mockImplementation((...args) => {
      created.push(String(args[0]))
      return realWrite(...(args as Parameters<typeof realWrite>))
    })
    const realWriteSync = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      created.push(String(args[0]))
      return realWriteSync(...(args as Parameters<typeof realWriteSync>))
    })
    const out = new BackgroundFile(() => file)
    out.write('v1')
    await BackgroundFile.whenAllWritten()
    out.write('v2')
    out.flushSync()
    await BackgroundFile.whenAllWritten()
    expect(fs.readFileSync(file, 'utf8')).toBe('v2')
    expect(created.length).toBeGreaterThan(0)
    expect(created.filter((p) => path.dirname(p) === dir)).toEqual([])
  })

  it('whenAllWritten resolves only once every file has its newest text on disk and no temp file is left', async () => {
    const other = path.join(dir, 'other.json')
    const a = new BackgroundFile(() => file)
    const b = new BackgroundFile(() => other)
    a.write('a1')
    b.write('b1')
    a.write('a2')
    await BackgroundFile.whenAllWritten()
    expect(fs.readFileSync(file, 'utf8')).toBe('a2')
    expect(fs.readFileSync(other, 'utf8')).toBe('b1')
    expect(fs.readdirSync(dir).sort()).toEqual([
      FOLDER_OF_HALF_WRITTEN_FILES,
      'other.json',
      'state.json'
    ])
    expect(halfWrittenFilesLeft()).toEqual([])
  })

  it('a flush at quit wins over an earlier save still being moved into place', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const realRename = fs.promises.rename
    let heldMoveDone: Promise<void> | undefined
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce((...args) => {
      heldMoveDone = held.then(() => realRename(...(args as Parameters<typeof realRename>)))
      return heldMoveDone
    })
    const out = new BackgroundFile(() => file)
    out.write('old')
    await vi.waitFor(() => expect(heldMoveDone).toBeDefined())
    out.write('new')
    out.flushSync()
    expect(fs.readFileSync(file, 'utf8')).toBe('new')
    release()
    await heldMoveDone?.catch(() => {})
    await BackgroundFile.whenAllWritten()
    expect(fs.readFileSync(file, 'utf8')).toBe('new')
    expect(halfWrittenFilesLeft()).toEqual([])
  })

  it('a flush at quit puts the newest text on disk at once, and a slower earlier write never overwrites it', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const realWrite = fs.promises.writeFile
    let heldWriteDone: Promise<void> | undefined
    vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce((...args) => {
      heldWriteDone = held.then(() => realWrite(...(args as Parameters<typeof realWrite>)))
      return heldWriteDone
    })
    const out = new BackgroundFile(() => file)
    out.write('old')
    out.write('new')
    await vi.waitFor(() => expect(heldWriteDone).toBeDefined())
    out.flushSync()
    expect(fs.readFileSync(file, 'utf8')).toBe('new')
    release()
    await heldWriteDone?.catch(() => {})
    await vi.waitFor(() => expect(halfWrittenFilesLeft()).toEqual([]))
    expect(fs.readFileSync(file, 'utf8')).toBe('new')
  })
})
