import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createFile, openForEdit, writeText } from '../../src/main/fileEdit'
import { EDIT_OPEN_MAX_BYTES, EDIT_WRITE_MAX_BYTES, sizeLabel } from '@shared/editLimits'

let dir: string
let file: string
const leftoverTmps = (d = dir): string[] =>
  fs.readdirSync(d).filter((n) => n.includes('.koloft-tmp-'))

const fingerprint = (p: string): { mtimeMs: number; size: number } => {
  const st = fs.statSync(p)
  return { mtimeMs: st.mtimeMs, size: st.size }
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-fe-')))
  file = path.join(dir, 'config.env')
  fs.writeFileSync(file, 'KEY=one\n')
})
afterEach(() => {
  vi.restoreAllMocks()
  try {
    fs.chmodSync(dir, 0o755)
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('openForEdit', () => {
  it('returns the text with a fingerprint, LF, and no read-only reason', async () => {
    const r = await openForEdit(file)
    expect(r.text).toBe('KEY=one\n')
    expect(r.eol).toBe('lf')
    expect(r.readOnly).toBe(null)
    expect(r).toMatchObject(fingerprint(file))
  })

  it('reports crlf for an all-CRLF file', async () => {
    fs.writeFileSync(file, 'a\r\nb\r\n')
    expect(await openForEdit(file)).toMatchObject({ eol: 'crlf', readOnly: null })
  })

  it('reads a file with no line breaks at all as lf', async () => {
    fs.writeFileSync(file, 'no newline here')
    expect(await openForEdit(file)).toMatchObject({ eol: 'lf', readOnly: null })
  })

  it('refuses mixed line endings, and a bare CR, as read-only', async () => {
    fs.writeFileSync(file, 'a\r\nb\nc\n')
    expect((await openForEdit(file)).readOnly).toBe('mixedEol')
    fs.writeFileSync(file, 'a\rb\n')
    expect((await openForEdit(file)).readOnly).toBe('mixedEol')
  })

  it('refuses a non-UTF-8 file, but NOT a valid UTF-8 file that contains U+FFFD', async () => {
    fs.writeFileSync(file, Buffer.from([0x61, 0xe9, 0x0a]))
    expect((await openForEdit(file)).readOnly).toBe('notUtf8')
    fs.writeFileSync(file, 'a � b\n', 'utf8')
    expect((await openForEdit(file)).readOnly).toBe(null)
  })

  it('keeps a BOM in the text it returns', async () => {
    fs.writeFileSync(file, '\uFEFFKEY=one\n', 'utf8')
    const r = await openForEdit(file)
    expect(r.text.charCodeAt(0)).toBe(0xfeff)
    expect(r.readOnly).toBe(null)
  })

  it('reports noPerm for a file the user cannot write', async () => {
    fs.chmodSync(file, 0o444)
    expect((await openForEdit(file)).readOnly).toBe('noPerm')
  })

  it('reports dirNotWritable when the file is writable but its directory is not', async () => {
    const sub = path.join(dir, 'locked')
    fs.mkdirSync(sub)
    const inner = path.join(sub, 'a.txt')
    fs.writeFileSync(inner, 'x\n')
    fs.chmodSync(sub, 0o555)
    try {
      expect((await openForEdit(inner)).readOnly).toBe('dirNotWritable')
    } finally {
      fs.chmodSync(sub, 0o755)
    }
  })

  it('measures the size cap in BYTES, not characters', async () => {
    fs.writeFileSync(file, '密钥密钥密钥密钥密钥密钥密钥密钥密钥密钥')
    expect(fs.statSync(file).size).toBe(60)
    await expect(openForEdit(file, 50)).rejects.toThrow('KOLOFT_TOO_LARGE')
    await expect(openForEdit(file, 60)).resolves.toBeDefined()
  })

  it('caps opening at 512 KB, well under the 1 MB write cap, and names each cap in whole units', async () => {
    expect(EDIT_OPEN_MAX_BYTES).toBe(512 * 1024)
    expect(EDIT_WRITE_MAX_BYTES).toBe(1024 * 1024)
    expect(EDIT_WRITE_MAX_BYTES).toBeGreaterThan(EDIT_OPEN_MAX_BYTES)
    expect(sizeLabel(EDIT_OPEN_MAX_BYTES)).toBe('512 KB')
    expect(sizeLabel(EDIT_WRITE_MAX_BYTES)).toBe('1 MB')
  })

  it('throws KOLOFT_GONE / KOLOFT_NOT_FILE / KOLOFT_BINARY for what it cannot open', async () => {
    await expect(openForEdit(path.join(dir, 'missing'))).rejects.toThrow('KOLOFT_GONE')
    await expect(openForEdit(dir)).rejects.toThrow('KOLOFT_NOT_FILE')
    fs.writeFileSync(path.join(dir, 'bin'), Buffer.from([0x41, 0x00, 0x42]))
    await expect(openForEdit(path.join(dir, 'bin'))).rejects.toThrow('KOLOFT_BINARY')
  })

  it('a file changed while it is being read makes the next save refused as stale, never a silent overwrite', async () => {
    const realRead = fs.promises.readFile
    let changed = false
    vi.spyOn(fs.promises, 'readFile').mockImplementation((async (
      p: unknown,
      ...rest: unknown[]
    ) => {
      const out = await (realRead as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
      if (p === file && !changed) {
        changed = true
        fs.writeFileSync(file, 'KEY=theirs, written mid-read\n')
      }
      return out
    }) as typeof fs.promises.readFile)
    const opened = await openForEdit(file)
    vi.restoreAllMocks()

    const r = await writeText(file, 'KEY=mine\n', { mtimeMs: opened.mtimeMs, size: opened.size })
    expect(r).toMatchObject({ ok: false, code: 'stale' })
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY=theirs, written mid-read\n')
  })
})

describe('a slow disk', () => {
  it('is not waited for on the main thread to find, read, create or flush a file', async () => {
    const waitsOnTheMainThread = [
      vi.spyOn(fs, 'realpathSync'),
      vi.spyOn(fs, 'accessSync'),
      vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(fs, 'openSync'),
      vi.spyOn(fs, 'fsyncSync')
    ]
    const opened = await openForEdit(file)
    const saved = await writeText(file, 'KEY=two\n', opened)
    expect(saved.ok).toBe(true)
    for (const call of waitsOnTheMainThread) expect(call).not.toHaveBeenCalled()
  })

  it('never lets two saves of one file both land: the second to finish is refused as stale', async () => {
    const opened = await openForEdit(file)
    const both = await Promise.all([
      writeText(file, 'KEY=first editor\n', opened),
      writeText(file, 'KEY=second editor\n', opened)
    ])
    expect(both.filter((r) => r.ok)).toHaveLength(1)
    expect(both.filter((r) => !r.ok)).toMatchObject([{ code: 'stale' }])
    expect(leftoverTmps()).toEqual([])
  })
})

describe('writeText', () => {
  it('replaces the content and hands back the NEW fingerprint, leaving no temp file', async () => {
    const before = fingerprint(file)
    const r = await writeText(file, 'KEY=two\n', before)
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY=two\n')
    if (r.ok) expect(r).toMatchObject(fingerprint(file))
    expect(leftoverTmps()).toEqual([])
  })

  it('a stale fingerprint writes NOTHING and returns the content on disk', async () => {
    const stale = { mtimeMs: 1, size: 999 }
    const r = await writeText(file, 'KEY=mine\n', stale)
    expect(r).toMatchObject({ ok: false, code: 'stale', text: 'KEY=one\n' })
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY=one\n')
    expect(leftoverTmps()).toEqual([])
  })

  it('catches a write that lands AFTER the first fingerprint check (§05 step 8)', async () => {
    const expect0 = fingerprint(file)
    const real = fs.promises.open
    vi.spyOn(fs.promises, 'open').mockImplementation(((p: string, ...rest: unknown[]) => {
      if (String(p).includes('.koloft-tmp-')) fs.writeFileSync(file, 'KEY=claude-was-here\n')
      return (real as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof fs.promises.open)

    const r = await writeText(file, 'KEY=mine\n', expect0)
    expect(r).toMatchObject({ ok: false, code: 'stale' })
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY=claude-was-here\n')
    vi.restoreAllMocks()
    expect(leftoverTmps()).toEqual([])
  })

  it('returns the fingerprint of what IT wrote, even if the file changes right after', async () => {
    const realRename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: string, to: string) => {
      ;(realRename as (a: string, b: string) => void)(from, to)
      fs.writeFileSync(file, 'KEY=claude-came-back-with-more\n')
    }) as typeof fs.renameSync)

    const r = await writeText(file, 'KEY=two\n', fingerprint(file))
    vi.restoreAllMocks()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.size).toBe(Buffer.byteLength('KEY=two\n'))
      expect(r.size).not.toBe(fs.statSync(file).size)
    }
  })

  it('a stale answer hands back null rather than a huge or binary file', async () => {
    const stale = { mtimeMs: 1, size: 999 }
    fs.writeFileSync(file, 'x'.repeat(600 * 1024))
    expect(await writeText(file, 'mine\n', stale)).toMatchObject({
      ok: false,
      code: 'stale',
      text: null
    })
    fs.writeFileSync(file, Buffer.from([0x41, 0x00, 0x42]))
    expect(await writeText(file, 'mine\n', stale)).toMatchObject({ text: null })
    fs.writeFileSync(file, 'KEY=one\n')
    expect(await writeText(file, 'mine\n', stale)).toMatchObject({ text: 'KEY=one\n' })
  })

  it('never deletes a file that already occupies the temp name', async () => {
    vi.spyOn(crypto, 'randomBytes').mockImplementation((() =>
      Buffer.from([0xde, 0xad, 0xbe, 0xef])) as unknown as typeof crypto.randomBytes)
    const squatter = path.join(dir, `.config.env.koloft-tmp-${process.pid}-deadbeef`)
    fs.writeFileSync(squatter, 'someone else was here\n')

    await expect(writeText(file, 'KEY=two\n', fingerprint(file))).rejects.toThrow()
    vi.restoreAllMocks()
    expect(fs.readFileSync(squatter, 'utf8')).toBe('someone else was here\n')
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY=one\n')
  })

  it('says the FOLDER is gone when the parent directory went away, not the file', async () => {
    const sub = path.join(dir, 'doomed')
    fs.mkdirSync(sub)
    const inner = path.join(sub, 'a.txt')
    fs.writeFileSync(inner, 'x\n')
    const fp = fingerprint(inner)
    fs.rmSync(sub, { recursive: true })
    await expect(writeText(inner, 'y\n', fp)).rejects.toThrow('KOLOFT_DIR_GONE')
    await expect(writeText(path.join(dir, 'missing'), 'y\n', fp)).rejects.toThrow(/KOLOFT_GONE$/)
  })

  it('creates the temp file as 0600 at BIRTH, not by a later chmod', async () => {
    const seen: Array<{ p: string; flags: unknown; mode: unknown }> = []
    const real = fs.promises.open
    vi.spyOn(fs.promises, 'open').mockImplementation(((
      p: string,
      flags: unknown,
      mode: unknown
    ) => {
      seen.push({ p: String(p), flags, mode })
      return (real as (...a: unknown[]) => unknown)(p, flags, mode)
    }) as typeof fs.promises.open)

    await writeText(file, 'KEY=two\n', fingerprint(file))
    const tmpOpen = seen.find((c) => c.p.includes('.koloft-tmp-'))
    expect(tmpOpen).toBeDefined()
    expect(tmpOpen?.flags).toBe('wx')
    expect(tmpOpen?.mode).toBe(0o600)
    expect(path.basename(String(tmpOpen?.p)).startsWith('.')).toBe(true)
  })

  it('keeps the original permissions: 0600 stays 0600, 0644 stays 0644', async () => {
    fs.chmodSync(file, 0o600)
    await writeText(file, 'a\n', fingerprint(file))
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)

    fs.chmodSync(file, 0o644)
    await writeText(file, 'b\n', fingerprint(file))
    expect(fs.statSync(file).mode & 0o777).toBe(0o644)
  })

  it('writes through a symlink to the real file, and the link survives', async () => {
    const link = path.join(dir, 'link.env')
    fs.symlinkSync(file, link)
    const r = await writeText(link, 'KEY=via-link\n', fingerprint(link))
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY=via-link\n')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
  })

  // PLATFORM§24
  it('CRLF in, CRLF out — and a file with no trailing newline keeps none', async () => {
    fs.writeFileSync(file, 'a\r\nb')
    const opened = await openForEdit(file)
    expect(opened.eol).toBe('crlf')
    expect(opened.text).toBe('a\r\nb')
    const r = await writeText(file, 'a\nb\nc', opened, { eol: 'crlf' })
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('a\r\nb\r\nc')
  })

  it('round-trips a BOM unchanged', async () => {
    fs.writeFileSync(file, '\uFEFFa\n', 'utf8')
    const opened = await openForEdit(file)
    await writeText(file, opened.text, opened)
    expect(fs.readFileSync(file)).toEqual(Buffer.from('\uFEFFa\n', 'utf8'))
  })

  it('honours force only as the literal true', async () => {
    const stale = { mtimeMs: 1, size: 999 }
    for (const force of ['true', 1, {}, 'yes'] as unknown[]) {
      const r = await writeText(file, 'nope\n', stale, { force } as { force?: boolean })
      expect(r).toMatchObject({ ok: false, code: 'stale' })
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY=one\n')
    const r = await writeText(file, 'KEY=forced\n', stale, { force: true })
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY=forced\n')
  })

  it('treats a missing or malformed expect as stale, never as a silent overwrite', async () => {
    for (const bad of [undefined, null, {}, { mtimeMs: 1 }, { mtimeMs: '1', size: 8 }, 'x']) {
      const r = await writeText(file, 'nope\n', bad as never)
      expect(r).toMatchObject({ ok: false, code: 'stale' })
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY=one\n')
  })

  it('throws KOLOFT_GONE / KOLOFT_NOT_FILE / KOLOFT_TOO_LARGE for what it cannot write', async () => {
    await expect(
      writeText(path.join(dir, 'missing'), 'x', { mtimeMs: 1, size: 1 })
    ).rejects.toThrow('KOLOFT_GONE')
    await expect(writeText(dir, 'x', fingerprint(dir))).rejects.toThrow('KOLOFT_NOT_FILE')
    await expect(writeText(file, '密钥密钥', fingerprint(file), undefined, 5)).rejects.toThrow(
      'KOLOFT_TOO_LARGE'
    )
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY=one\n')
  })

  it('cleans the temp file up and leaves the original intact when the rename fails', async () => {
    const boom = Object.assign(new Error('nope'), { code: 'EACCES' })
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw boom
    })
    await expect(writeText(file, 'KEY=two\n', fingerprint(file))).rejects.toThrow('KOLOFT_NO_PERM')
    vi.restoreAllMocks()
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY=one\n')
    expect(leftoverTmps()).toEqual([])
  })

  it('reads a read-only volume (EROFS) as "not allowed to write", not as a generic failure', async () => {
    const boom = Object.assign(new Error('read-only'), { code: 'EROFS' })
    vi.spyOn(fs.promises, 'open').mockRejectedValue(boom)
    await expect(writeText(file, 'KEY=two\n', fingerprint(file))).rejects.toThrow('KOLOFT_NO_PERM')
    vi.restoreAllMocks()
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY=one\n')
  })
})

describe('createFile', () => {
  it('creates an empty file and hands back its fingerprint', async () => {
    const r = await createFile(dir, 'new.env')
    expect(r.path).toBe(path.join(dir, 'new.env'))
    expect(r.size).toBe(0)
    expect(fs.readFileSync(r.path, 'utf8')).toBe('')
    expect(r).toMatchObject(fingerprint(r.path))
  })

  it('refuses an existing name atomically, without truncating what is there', async () => {
    await expect(createFile(dir, 'config.env')).rejects.toThrow('KOLOFT_EXISTS')
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY=one\n')
  })

  it('refuses a name that is a path, or a dot entry, before it reaches the folder', async () => {
    for (const bad of ['a/b.txt', 'a\\b.txt', '..', '.', '', '/etc/passwd']) {
      await expect(createFile(dir, bad)).rejects.toThrow('KOLOFT_BAD_NAME')
    }
    await expect(createFile(dir, '.env')).resolves.toMatchObject({ size: 0 })
  })

  it('says the folder is gone when the directory does not exist', async () => {
    await expect(createFile(path.join(dir, 'no-such-dir'), 'a.txt')).rejects.toThrow(
      'KOLOFT_DIR_GONE'
    )
  })
})
