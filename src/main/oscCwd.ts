import os from 'os'

const ESC = '\x1b'
const BEL = '\x07'

/** Longest partial sequence carried between pty chunks. A real OSC 7 is a path, so
 *  anything longer is binary noise that happened to contain `ESC ]` (`cat` on a jpeg)
 *  — buffering it would hold the rest of the session hostage. */
export const OSC_CARRY_MAX = 4096

/** D13: the local host, as the shell writes it. macOS's precmd hook interpolates zsh's
 *  `$HOST` UNENCODED, so it can hold spaces and quotes; a report from anywhere else is
 *  an ssh session inside the shell and describes a directory that isn't on this
 *  machine. Empty and `localhost` are the conventional "here" spellings. */
function isLocalHost(host: string, hostname: string): boolean {
  if (host === '') return true
  const h = host.toLowerCase()
  return h === 'localhost' || h === hostname.toLowerCase()
}

/** The directory an OSC body (everything between `ESC ]` and the terminator) reports,
 *  or undefined when it is not an OSC 7 naming a local path. */
function cwdFromBody(body: string, hostname: string): string | undefined {
  const semi = body.indexOf(';')
  if (semi < 0 || body.slice(0, semi) !== '7') return undefined
  const uri = body.slice(semi + 1)
  if (!uri.startsWith('file://')) return undefined
  const rest = uri.slice('file://'.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return undefined
  if (!isLocalHost(rest.slice(0, slash), hostname)) return undefined
  try {
    return decodeURIComponent(rest.slice(slash))
  } catch {
    // a half-written escape that survived reassembly — a path we cannot decode is not
    // one worth persisting, so the tab keeps its last known directory
    return undefined
  }
}

/**
 * D13 — the per-pty OSC 7 cwd tracker. A shell reports its directory as
 * `ESC ] 7; file://<host><percent-encoded path>` terminated by BEL or `ESC \`, on
 * every prompt (macOS's /etc/zshrc_Apple_Terminal precmd hook, which Koloft enables by
 * impersonating Apple Terminal — ptyManager).
 *
 * The parser is stateful because node-pty chunks are arbitrary: a sequence can be torn
 * anywhere, including inside a percent-escape or between the two bytes of an `ESC \`
 * terminator. xterm's parser used to absorb that for free; it went with the free
 * terminal in so the carry is ours to keep now.
 */
export class OscCwdParser {
  /** an unterminated sequence's bytes, from its ESC, waiting for the rest */
  private carry = ''

  constructor(private readonly hostname: string = os.hostname()) {}

  /** Feed one pty chunk; returns the last directory it reported, if any. */
  push(chunk: string): string | undefined {
    const s = this.carry + chunk
    this.carry = ''
    let found: string | undefined
    let i = 0
    while (i < s.length) {
      const esc = s.indexOf(ESC, i)
      if (esc < 0) break
      // ESC as the last byte we have: `]` may still be coming
      if (esc + 1 >= s.length) return this.hold(s.slice(esc), found)
      if (s[esc + 1] !== ']') {
        i = esc + 1
        continue
      }
      let j = esc + 2
      let end = -1
      let termLen = 0
      for (; j < s.length; j++) {
        const c = s[j]
        if (c === BEL) {
          end = j
          termLen = 1
          break
        }
        if (c === ESC) {
          // the ST terminator is ESC \; any other ESC aborts this sequence (a CSI the
          // shell wrote over an OSC it never finished)
          if (j + 1 >= s.length) return this.hold(s.slice(esc), found)
          if (s[j + 1] === '\\') {
            end = j
            termLen = 2
          }
          break
        }
      }
      if (end < 0) {
        // aborted by another ESC → rescan from it; ran out of bytes → carry
        if (j < s.length) {
          i = j
          continue
        }
        return this.hold(s.slice(esc), found)
      }
      found = cwdFromBody(s.slice(esc + 2, end), this.hostname) ?? found
      i = end + termLen
    }
    return found
  }

  private hold(partial: string, found: string | undefined): string | undefined {
    this.carry = partial.length <= OSC_CARRY_MAX ? partial : ''
    return found
  }
}
