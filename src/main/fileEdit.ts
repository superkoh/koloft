import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  EditCreateResult,
  EditFingerprint,
  EditOpenResult,
  EditWriteResult
} from '@shared/types'

/**
 * The main-process half of the file editor (§05). Reading with a fingerprint, and the
 * atomic write that checks it twice.
 *
 * There is no fence: Koloft writes wherever the person pointed it (the roots-based
 * one was removed along with the workspace-root assumption behind it, since a session can
 * move to another checkout mid-conversation). What remains are the limits that are about
 * the file itself: it is a plain file, its size, its encoding, and its fingerprint.
 *
 * Errors cross the IPC boundary as `KOLOFT_*` message strings — Electron drops `err.code`,
 * and the existing read channel already speaks this way.
 */

/** Cap text reads fed to the previewer / code viewer so a multi-hundred-MB file can't be
 *  pulled whole into the main process and shipped to the renderer (where Shiki would
 *  tokenize all of it and freeze the UI). */
export const MAX_READ_BYTES = 2 * 1024 * 1024

/** N-01: editing is capped well below reading — a 2 MB single line costs 92ms to lay out
 *  the first time (measured), which this keeps out. */
export const EDIT_OPEN_MAX_BYTES = 512 * 1024
/** N-01: saving is capped a notch ABOVE opening, so pasting a few lines into a file you
 *  just opened can never produce "opens fine, won't save, only copy is in memory". */
export const EDIT_WRITE_MAX_BYTES = 1024 * 1024

/** Detect binary on the raw bytes (a NUL byte, or many control bytes) before decoding —
 *  a utf8 + NUL-only check misses high-byte non-UTF-8 files. */
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

/**
 * Which line ending this file uses, and whether it uses more than one. Mixed is a
 * read-only reason rather than something to normalize: a browser textarea turns CRLF AND
 * a lone CR into LF (measured), so saving such a file back would rewrite every line it
 * did not touch and show up in git as a whole-file change.
 */
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

/** map a filesystem failure onto the three outcomes the conflict bar knows how to explain */
function writeError(e: unknown): Error {
  if (e instanceof Error && e.message.startsWith('KOLOFT_')) return e
  const code = (e as NodeJS.ErrnoException | null)?.code
  // EROFS is a read-only volume: to the user that is "not allowed to write here", the
  // same story as a permission bit, so it gets the same message rather than the generic one.
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new Error('KOLOFT_NO_PERM')
  if (code === 'ENOENT') return new Error('KOLOFT_GONE')
  return new Error('KOLOFT_WRITE_FAILED')
}

/**
 * §05: read a file for editing. Throws when it cannot be shown at all; answers with a
 * `readOnly` reason when it can be shown but not changed — the ✎ button greys out on that
 * value rather than letting the user find out at save time.
 */
export function openForEdit(p: string, maxBytes = EDIT_OPEN_MAX_BYTES): EditOpenResult {
  if (typeof p !== 'string' || !p) throw new Error('KOLOFT_READ_FAILED')
  let real: string
  try {
    real = fs.realpathSync(p)
  } catch {
    throw new Error('KOLOFT_GONE')
  }

  let st: fs.Stats
  try {
    st = fs.statSync(real)
  } catch {
    throw new Error('KOLOFT_GONE')
  }
  if (!st.isFile()) throw new Error('KOLOFT_NOT_FILE')
  if (st.size > maxBytes) throw new Error('KOLOFT_TOO_LARGE')

  // stat BEFORE read on purpose: if the file changes in between, the fingerprint we hand
  // out is older than the text, so the next save is refused as stale — the safe side. The
  // other order would hand out a fingerprint newer than the text and overwrite silently.
  let buf: Buffer
  try {
    buf = fs.readFileSync(real)
  } catch {
    throw new Error('KOLOFT_READ_FAILED')
  }
  if (looksBinary(buf)) throw new Error('KOLOFT_BINARY')

  const text = buf.toString('utf8')
  // UTF-8 is decided by a byte round-trip, never by looking for U+FFFD: that character is
  // legal content, and a file that merely mentions it would be locked for no reason. A BOM
  // round-trips as itself, so it is simply kept.
  const utf8 = Buffer.from(text, 'utf8').equals(buf)
  const { eol, mixed } = eolOf(text)

  const readOnly: EditOpenResult['readOnly'] = !utf8
    ? 'notUtf8'
    : mixed
      ? 'mixedEol'
      : !canWrite(real)
        ? 'noPerm'
        : // the dead angle: with an unwritable PARENT the temp file cannot be created
          // (EACCES) while a plain overwrite would have worked, so the file looks writable
          // and every save fails. Say so at open time instead.
          !canWrite(path.dirname(real))
          ? 'dirNotWritable'
          : null

  return { text, mtimeMs: st.mtimeMs, size: st.size, eol, readOnly }
}

/** the file as the conflict bar needs to see it, or null when it cannot be shown — the
 *  same two limits the editor itself obeys, since what comes back here is destined for
 *  the very same diff view */
function staleResult(real: string, st: fs.Stats): EditWriteResult {
  let text: string | null = null
  if (st.size <= EDIT_OPEN_MAX_BYTES) {
    try {
      const buf = fs.readFileSync(real)
      if (!looksBinary(buf)) text = buf.toString('utf8')
    } catch {
      // unreadable now — the conflict bar still has a fingerprint to re-open from
    }
  }
  return { ok: false, code: 'stale', mtimeMs: st.mtimeMs, size: st.size, text }
}

/** `realpath` failed: say which of the two is missing, because the answers differ — a
 *  gone file can be re-created at its old path, a gone folder cannot (and we must not
 *  quietly re-create the folder either). */
function goneError(p: string): Error {
  return new Error(fs.existsSync(path.dirname(p)) ? 'KOLOFT_GONE' : 'KOLOFT_DIR_GONE')
}

/**
 * §05 "the nine things": write `text` to `p` atomically, refusing if the file moved under
 * us. The temp file is born 0600 in the TARGET's own directory — a system temp dir would
 * copy the content onto another disk, and a plain `writeFile` would leave a secrets file
 * at umask 0644 if we crashed mid-write. There is no fallback to a direct overwrite
 * (B-23): a failed atomic write leaves the original whole, a failed overwrite does not.
 *
 * "Atomic" guarantees the rename cannot half-happen, so a truncated file is impossible. It
 * does NOT guarantee the bytes survive a power cut — macOS's fsync does not flush the
 * drive cache (that needs F_FULLFSYNC, which Node does not expose).
 */
export function writeText(
  p: string,
  text: string,
  expect: unknown,
  opts?: { force?: unknown; eol?: unknown },
  maxBytes = EDIT_WRITE_MAX_BYTES
): EditWriteResult {
  if (typeof p !== 'string' || !p) throw new Error('KOLOFT_GONE')
  if (typeof text !== 'string') throw new Error('KOLOFT_WRITE_FAILED')
  // force is honoured as the literal `true` alone: anything else — including a missing or
  // malformed `expect` — falls to the safe side and reads as "the file changed", so a
  // caller that forgets an argument can never silently clobber.
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

  const matches = (s: fs.Stats): boolean =>
    isFingerprint(expect) && s.mtimeMs === expect.mtimeMs && s.size === expect.size
  if (!force && !matches(st)) return staleResult(real, st)

  const data = Buffer.from(opts?.eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text, 'utf8')
  const dir = path.dirname(real)
  // dot-prefixed with a fixed infix so a stray one is recognizable to a human, to the
  // Changes list, and to whatever else is watching the directory
  const tmp = path.join(
    dir,
    `.${path.basename(real)}.koloft-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  )
  let created = false
  let done = false
  let after: fs.Stats
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600)
    // only now is the temp file OURS to delete. `wx` failing means the name was already
    // taken, and the cleanup below must not remove a stranger's file.
    created = true
    try {
      fs.writeFileSync(fd, data)
      fs.fsyncSync(fd)
      // fchmod on the open handle, so the mode never depends on the path still being ours.
      // Only the permission bits: the owner cannot be changed and trying is EPERM.
      fs.fchmodSync(fd, st.mode & 0o7777)
      // the fingerprint of what WE wrote, taken through the handle before the rename. A
      // stat of the path afterwards would describe whatever is there by then — hand that
      // back and the next save silently overwrites a stranger's work, while the watcher
      // event that would have warned us reads as our own echo.
      after = fs.fstatSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    // The second check, and the reason for it: between the first one and the rename there
    // is a real window (6.1ms measured for 2 MB), which is plenty for Claude to finish a
    // write of its own. Checking again here narrows it to microseconds.
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
    } catch {
      // the rename already happened; a directory that cannot be fsynced only costs
      // durability across a power cut, which is not promised anyway
    }
  } catch (e) {
    throw writeError(e)
  } finally {
    if (created && !done) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // already gone
      }
    }
  }

  return { ok: true, mtimeMs: after.mtimeMs, size: after.size }
}

/**
 * B-06: create an empty file. Whether the name is free is decided by the creation itself
 * (`wx`), never by looking first — between a check and a write someone else can create the
 * very file. A name with a slash in it is refused here, so that `a/b.txt` gets a sentence
 * about names rather than quietly creating a file one folder over.
 */
export function createFile(dirPath: string, name: string): EditCreateResult {
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
  if (typeof dirPath !== 'string' || !dirPath) throw new Error('KOLOFT_GONE')

  let realDir: string
  try {
    realDir = fs.realpathSync(dirPath)
  } catch {
    // nothing is being re-created here, so the only thing that can be missing is the
    // folder the user right-clicked
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
