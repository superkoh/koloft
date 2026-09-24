import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  EditCreateResult,
  EditFingerprint,
  EditOpenResult,
  EditWriteResult
} from '@shared/types'

export const MAX_READ_BYTES = 2 * 1024 * 1024

export const EDIT_OPEN_MAX_BYTES = 512 * 1024
export const EDIT_WRITE_MAX_BYTES = 1024 * 1024

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

function canWrite(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
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

function isFingerprint(v: unknown): v is EditFingerprint {
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

export function openForEdit(p: string, maxBytes = EDIT_OPEN_MAX_BYTES): EditOpenResult {
  if (typeof p !== 'string' || !p) throw new Error('KOLOFT_READ_FAILED')
  let real: string
  try {
    real = fs.realpathSync(p)
  } catch {
    throw new Error('KOLOFT_GONE')
  }

  let statBeforeRead: fs.Stats
  try {
    statBeforeRead = fs.statSync(real)
  } catch {
    throw new Error('KOLOFT_GONE')
  }
  if (!statBeforeRead.isFile()) throw new Error('KOLOFT_NOT_FILE')
  if (statBeforeRead.size > maxBytes) throw new Error('KOLOFT_TOO_LARGE')

  let buf: Buffer
  try {
    buf = fs.readFileSync(real)
  } catch {
    throw new Error('KOLOFT_READ_FAILED')
  }
  return editOpenResult(buf, statBeforeRead, {
    file: () => canWrite(real),
    dir: () => canWrite(path.dirname(real))
  })
}

export function editOpenResult(
  buf: Buffer,
  fp: EditFingerprint,
  writable: { file: () => boolean; dir: () => boolean }
): EditOpenResult {
  if (looksBinary(buf)) throw new Error('KOLOFT_BINARY')

  const text = buf.toString('utf8')
  const utf8 = Buffer.from(text, 'utf8').equals(buf)
  const { eol, mixed } = eolOf(text)

  const readOnly: EditOpenResult['readOnly'] = !utf8
    ? 'notUtf8'
    : mixed
      ? 'mixedEol'
      : !writable.file()
        ? 'noPerm'
        : !writable.dir()
          ? 'dirNotWritable'
          : null

  return { text, mtimeMs: fp.mtimeMs, size: fp.size, eol, readOnly }
}

export function sameFingerprint(expect: unknown, now: EditFingerprint): boolean {
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

function staleResult(real: string, st: fs.Stats): EditWriteResult {
  let text: string | null = null
  if (st.size <= EDIT_OPEN_MAX_BYTES) {
    try {
      const buf = fs.readFileSync(real)
      if (!looksBinary(buf)) text = buf.toString('utf8')
    } catch {}
  }
  return { ok: false, code: 'stale', mtimeMs: st.mtimeMs, size: st.size, text }
}

function goneError(p: string): Error {
  return new Error(fs.existsSync(path.dirname(p)) ? 'KOLOFT_GONE' : 'KOLOFT_DIR_GONE')
}

// PLATFORM§3
export function writeText(
  p: string,
  text: string,
  expect: unknown,
  opts?: { force?: unknown; eol?: unknown },
  maxBytes = EDIT_WRITE_MAX_BYTES
): EditWriteResult {
  if (typeof p !== 'string' || !p) throw new Error('KOLOFT_GONE')
  if (typeof text !== 'string') throw new Error('KOLOFT_WRITE_FAILED')
  const force = opts?.force === true
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('KOLOFT_TOO_LARGE')

  let real: string
  try {
    real = fs.realpathSync(p)
  } catch {
    throw goneError(p)
  }

  let st: fs.Stats
  try {
    st = fs.statSync(real)
  } catch {
    throw goneError(real)
  }
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
    const fd = fs.openSync(tmp, 'wx', 0o600)
    created = true
    try {
      fs.writeFileSync(fd, data)
      fs.fsyncSync(fd)
      fs.fchmodSync(fd, st.mode & 0o7777)
      after = fs.fstatSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    if (!force) {
      const now = fs.statSync(real)
      if (!matches(now)) return staleResult(real, now)
    }

    fs.renameSync(tmp, real)
    done = true
    try {
      const dfd = fs.openSync(dir, 'r')
      try {
        fs.fsyncSync(dfd)
      } finally {
        fs.closeSync(dfd)
      }
    } catch {}
  } catch (e) {
    throw writeError(e)
  } finally {
    if (created && !done) {
      try {
        fs.unlinkSync(tmp)
      } catch {}
    }
  }

  return { ok: true, mtimeMs: after.mtimeMs, size: after.size }
}

export function createFile(dirPath: string, name: string): EditCreateResult {
  checkNewFileName(name)
  if (typeof dirPath !== 'string' || !dirPath) throw new Error('KOLOFT_GONE')

  let realDir: string
  try {
    realDir = fs.realpathSync(dirPath)
  } catch {
    throw new Error('KOLOFT_DIR_GONE')
  }
  const target = path.join(realDir, name)

  let fd: number
  try {
    fd = fs.openSync(target, 'wx', 0o644)
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === 'EEXIST') throw new Error('KOLOFT_EXISTS')
    throw writeError(e)
  }
  fs.closeSync(fd)
  const st = fs.statSync(target)
  return { path: target, mtimeMs: st.mtimeMs, size: st.size }
}
