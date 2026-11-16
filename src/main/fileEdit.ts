import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  EditCreateResult,
  EditFingerprint,
  EditOpenResult,
  EditWriteResult
} from '@shared/types'
import { EDIT_OPEN_MAX_BYTES, EDIT_WRITE_MAX_BYTES } from '@shared/editLimits'

export const MAX_READ_BYTES = 2 * 1024 * 1024

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  let control = 0
  for (let i = 0; i < n; i++) {
    const b = buf[i]
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32)) control++
  }
  return n > 0 && control / n > 0.1
}

function canWrite(p: string): Promise<boolean> {
  return fs.promises.access(p, fs.constants.W_OK).then(
    () => true,
    () => false
  )
}

// PLATFORM§24
function eolOf(text: string): { eol: 'lf' | 'crlf'; mixed: boolean } {
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++
        i++
      } else cr++
    } else if (c === 10) lf++
  }
  if (cr > 0 || (crlf > 0 && lf > 0)) return { eol: 'lf', mixed: true }
  return { eol: crlf > 0 ? 'crlf' : 'lf', mixed: false }
}

export function isFingerprint(v: unknown): v is EditFingerprint {
  const fp = v as EditFingerprint | null
  return !!fp && typeof fp.mtimeMs === 'number' && typeof fp.size === 'number'
}

// PLATFORM§6
function writeError(e: unknown): Error {
  if (e instanceof Error && e.message.startsWith('KOLOFT_')) return e
  const code = (e as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new Error('KOLOFT_NO_PERM')
  if (code === 'ENOENT') return new Error('KOLOFT_GONE')
  return new Error('KOLOFT_WRITE_FAILED')
}

// PLATFORM§69
export async function openForEdit(
  p: string,
  maxBytes = EDIT_OPEN_MAX_BYTES
): Promise<EditOpenResult> {
  if (typeof p !== 'string' || !p) throw new Error('KOLOFT_READ_FAILED')
  const real = await fs.promises.realpath(p).catch(() => {
    throw new Error('KOLOFT_GONE')
  })
  const statBeforeRead = await fs.promises.stat(real).catch(() => {
    throw new Error('KOLOFT_GONE')
  })
  if (!statBeforeRead.isFile()) throw new Error('KOLOFT_NOT_FILE')
  if (statBeforeRead.size > maxBytes) throw new Error('KOLOFT_TOO_LARGE')

  const buf = await fs.promises.readFile(real).catch(() => {
    throw new Error('KOLOFT_READ_FAILED')
  })
  const [file, dir] = await Promise.all([canWrite(real), canWrite(path.dirname(real))])
  return editOpenResult(buf, statBeforeRead, { file, dir })
}

export function editOpenResult(
  buf: Buffer,
  fp: EditFingerprint,
  writable: { file: boolean; dir: boolean }
): EditOpenResult {
  if (looksBinary(buf)) throw new Error('KOLOFT_BINARY')

  const text = buf.toString('utf8')
  const utf8 = Buffer.from(text, 'utf8').equals(buf)
  const { eol, mixed } = eolOf(text)

  const readOnly: EditOpenResult['readOnly'] = !utf8
    ? 'notUtf8'
    : mixed
      ? 'mixedEol'
      : !writable.file
        ? 'noPerm'
        : !writable.dir
          ? 'dirNotWritable'
          : null

  return { text, mtimeMs: fp.mtimeMs, size: fp.size, eol, readOnly }
}

function sameFingerprint(expect: unknown, now: EditFingerprint): boolean {
  return isFingerprint(expect) && now.mtimeMs === expect.mtimeMs && now.size === expect.size
}

export function bytesToWrite(text: string, eol: unknown): Buffer {
  return Buffer.from(eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text, 'utf8')
}

export function checkNewFileName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new Error('KOLOFT_BAD_NAME')
  }
}

async function staleResult(real: string, st: fs.Stats): Promise<EditWriteResult> {
  let text: string | null = null
  if (st.size <= EDIT_OPEN_MAX_BYTES) {
    const buf = await fs.promises.readFile(real).catch(() => null)
    if (buf && !looksBinary(buf)) text = buf.toString('utf8')
  }
  return { ok: false, code: 'stale', mtimeMs: st.mtimeMs, size: st.size, text }
}

async function goneError(p: string): Promise<Error> {
  const folderThere = await fs.promises.access(path.dirname(p)).then(
    () => true,
    () => false
  )
  return new Error(folderThere ? 'KOLOFT_GONE' : 'KOLOFT_DIR_GONE')
}

// PLATFORM§3 PLATFORM§69
export async function writeText(
  p: string,
  text: string,
  expect: unknown,
  opts?: { force?: unknown; eol?: unknown },
  maxBytes = EDIT_WRITE_MAX_BYTES
): Promise<EditWriteResult> {
  if (typeof p !== 'string' || !p) throw new Error('KOLOFT_GONE')
  if (typeof text !== 'string') throw new Error('KOLOFT_WRITE_FAILED')
  const force = opts?.force === true
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('KOLOFT_TOO_LARGE')

  const real = await fs.promises.realpath(p).catch(async () => {
    throw await goneError(p)
  })
  const st = await fs.promises.stat(real).catch(async () => {
    throw await goneError(real)
  })
  if (!st.isFile()) throw new Error('KOLOFT_NOT_FILE')

  const matches = (s: fs.Stats): boolean => sameFingerprint(expect, s)
  if (!force && !matches(st)) return staleResult(real, st)

  const data = bytesToWrite(text, opts?.eol)
  const dir = path.dirname(real)
  const tmp = path.join(
    dir,
    `.${path.basename(real)}.koloft-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  )
  let created = false
  let done = false
  let after: fs.Stats
  try {
    const half = await fs.promises.open(tmp, 'wx', 0o600)
    created = true
    try {
      await half.writeFile(data)
      await half.sync()
      await half.chmod(st.mode & 0o7777)
      after = await half.stat()
    } finally {
      await half.close()
    }

    if (!force) {
      const now = fs.statSync(real)
      if (!matches(now)) return await staleResult(real, now)
    }
    fs.renameSync(tmp, real)
    done = true
    try {
      const folder = await fs.promises.open(dir, 'r')
      try {
        await folder.sync()
      } finally {
        await folder.close()
      }
    } catch {}
  } catch (e) {
    throw writeError(e)
  } finally {
    if (created && !done) await fs.promises.unlink(tmp).catch(() => {})
  }

  return { ok: true, mtimeMs: after.mtimeMs, size: after.size }
}

// PLATFORM§69
export async function createFile(dirPath: string, name: string): Promise<EditCreateResult> {
  checkNewFileName(name)
  if (typeof dirPath !== 'string' || !dirPath) throw new Error('KOLOFT_GONE')

  let realDir: string
  try {
    realDir = await fs.promises.realpath(dirPath)
  } catch {
    throw new Error('KOLOFT_DIR_GONE')
  }
  const target = path.join(realDir, name)

  let file: fs.promises.FileHandle
  try {
    file = await fs.promises.open(target, 'wx', 0o644)
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === 'EEXIST') throw new Error('KOLOFT_EXISTS')
    throw writeError(e)
  }
  try {
    const st = await file.stat()
    return { path: target, mtimeMs: st.mtimeMs, size: st.size }
  } finally {
    await file.close().catch(() => {})
  }
}
