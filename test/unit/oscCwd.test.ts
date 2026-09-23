import { describe, it, expect } from 'vitest'
import { OscCwdParser, OSC_CARRY_MAX } from '../../src/main/oscCwd'

// D13 — the OSC 7 cwd tracker. The old parser was xterm's (deleted with the free
// terminal later), so this one is main-side and hand-rolled: it sees the pty's
// raw byte stream in whatever chunks node-pty hands over, which is exactly where a
// hand-rolled parser goes wrong. macOS's /etc/zshrc_Apple_Terminal emits
// `ESC ] 7; file://<host><percent-encoded path> BEL` from a precmd hook, verified on
// a real pty — host is NOT encoded, and a real one can contain spaces and
// an apostrophe (macOS names machines "Ada's MacBook Pro"), which is why host matching
// compares the raw substring up to the first slash.

const BEL = '\x07'
const ESC = '\x1b'
const HOST = "Ada's MacBook Pro"

/** One OSC 7 report, BEL-terminated (what Apple's precmd hook writes). */
function osc7(uri: string, term = BEL): string {
  return `${ESC}]7;${uri}${term}`
}

describe('oscCwd: extracting the directory (D13 ①)', () => {
  it('reads the path out of file://<host>/<path>', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(osc7(`file://${HOST}/Users/me/Projects/app`))).toBe('/Users/me/Projects/app')
  })

  it('accepts an empty host (file:///…) and localhost', () => {
    expect(new OscCwdParser(HOST).push(osc7('file:///tmp'))).toBe('/tmp')
    expect(new OscCwdParser(HOST).push(osc7('file://localhost/tmp'))).toBe('/tmp')
    expect(new OscCwdParser(HOST).push(osc7('file://LOCALHOST/tmp'))).toBe('/tmp')
  })

  it('takes the ESC-backslash (ST) terminator as well as BEL', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(osc7('file:///var/log', `${ESC}\\`))).toBe('/var/log')
  })

  it('finds the report among unrelated output', () => {
    const p = new OscCwdParser(HOST)
    const noise = `${ESC}[1m$ ls${ESC}[0m\r\nREADME.md\r\n`
    expect(p.push(noise + osc7('file:///tmp/x') + noise)).toBe('/tmp/x')
  })

  it('reports the LAST directory when a chunk carries several', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(osc7('file:///a') + osc7('file:///b'))).toBe('/b')
  })

  it('answers undefined for a chunk with no report at all', () => {
    expect(new OscCwdParser(HOST).push('just some output\r\n')).toBeUndefined()
  })
})

describe('oscCwd: percent-decoding (D13 ②)', () => {
  it('decodes escaped characters — Apple encodes everything but [/._~A-Za-z0-9-]', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(osc7('file:///Users/me/My%20Docs%20%26%20Notes'))).toBe(
      '/Users/me/My Docs & Notes'
    )
  })

  it('decodes multi-byte UTF-8 escapes', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(osc7('file:///Users/me/%E9%A1%B9%E7%9B%AE'))).toBe('/Users/me/项目')
  })

  it('drops a report whose escapes are malformed rather than persisting the raw text', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(osc7('file:///Users/me/%zz'))).toBeUndefined()
  })
})

describe('oscCwd: sequences split across pty chunks (D13 ③)', () => {
  it('joins a split in the middle of file://', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(`${ESC}]7;fi`)).toBeUndefined()
    expect(p.push(`le:///tmp/split${BEL}`)).toBe('/tmp/split')
  })

  it('joins a split in the middle of a percent-escape', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(`${ESC}]7;file:///Users/me/a%2`)).toBeUndefined()
    expect(p.push(`0b${BEL}`)).toBe('/Users/me/a b')
  })

  it('joins a split right before the BEL terminator', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(`${ESC}]7;file:///tmp/bel`)).toBeUndefined()
    expect(p.push(BEL)).toBe('/tmp/bel')
  })

  it('joins a split INSIDE the ESC-backslash terminator', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(`${ESC}]7;file:///tmp/st${ESC}`)).toBeUndefined()
    expect(p.push('\\')).toBe('/tmp/st')
  })

  it('joins a split between the ESC and the ] that opens the sequence', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(`done\r\n${ESC}`)).toBeUndefined()
    expect(p.push(`]7;file:///tmp/lone${BEL}`)).toBe('/tmp/lone')
  })

  it('survives being fed one character at a time', () => {
    const p = new OscCwdParser(HOST)
    const stream = `x${osc7('file:///Users/me/one%20two')}y`
    let last: string | undefined
    for (const ch of stream) last = p.push(ch) ?? last
    expect(last).toBe('/Users/me/one two')
  })

  it('drops an unterminated sequence once it outgrows the carry cap', () => {
    const p = new OscCwdParser(HOST)
    // a binary blob (`cat` on a jpeg) that happens to contain ESC ] must not make the
    // parser buffer the rest of the session
    expect(p.push(`${ESC}]7;file:///${'a'.repeat(OSC_CARRY_MAX)}`)).toBeUndefined()
    expect(p.push(`more${BEL}`)).toBeUndefined()
    // …and the parser still works on the next real report
    expect(p.push(osc7('file:///tmp/after'))).toBe('/tmp/after')
  })

  it('abandons a sequence a new ESC interrupts, and reads the one that follows', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(`${ESC}]7;file:///never${ESC}[0m${osc7('file:///tmp/real')}`)).toBe('/tmp/real')
  })
})

describe('oscCwd: reports that are not ours (D13 ④⑤)', () => {
  it('ignores OSC numbers other than 7', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(`${ESC}]0;some window title${BEL}`)).toBeUndefined()
    expect(p.push(`${ESC}]133;A${BEL}`)).toBeUndefined()
    // …including one whose payload looks exactly like ours
    expect(p.push(`${ESC}]17;file:///tmp/nope${BEL}`)).toBeUndefined()
  })

  it('ignores a report from another host — an ssh session inside the shell', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(osc7('file://build-box.internal/home/ci'))).toBeUndefined()
  })

  it('matches the local hostname case-insensitively', () => {
    const p = new OscCwdParser('Some-Mac.local')
    expect(p.push(osc7('file://some-mac.local/tmp'))).toBe('/tmp')
  })

  it('ignores a non-file scheme and a URI with no path at all', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(osc7('http://example.com/tmp'))).toBeUndefined()
    expect(p.push(osc7(`file://${HOST}`))).toBeUndefined()
  })

  it('ignores an OSC 7 with no payload', () => {
    const p = new OscCwdParser(HOST)
    expect(p.push(`${ESC}]7${BEL}`)).toBeUndefined()
  })
})
