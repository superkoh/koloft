import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { suppressXtversionReply } from '../../src/renderer/src/xtversionMask'

// XTVERSION contract (xterm docs): query is CSI > 0 q (or bare CSI > q); a terminal
// that answers replies DCS > | <name> ST. DA1 (CSI 0 c) is a separate identity query
// xterm always answers — it serves as the liveness control proving the write/parse/
// reply pipeline ran, so "no XTVERSION reply" can never pass vacuously.
const XTVERSION_QUERY = '\x1b[>0q'
const XTVERSION_QUERY_BARE = '\x1b[>q'
const DA1_QUERY = '\x1b[0c'

const collect = (term: Terminal, input: string): Promise<string> =>
  new Promise((resolve) => {
    let out = ''
    term.onData((d) => {
      out += d
    })
    term.write(input, () => resolve(out))
  })

describe('suppressXtversionReply', () => {
  it('unmasked 6.1 terminal answers XTVERSION with an xterm.js identity (mask premise)', async () => {
    const term = new Terminal({ allowProposedApi: true })
    const reply = await collect(term, XTVERSION_QUERY)
    expect(reply).toContain('\x1bP>|xterm.js')
  })

  it('masked terminal stays silent on XTVERSION but still answers DA1', async () => {
    const term = new Terminal({ allowProposedApi: true })
    suppressXtversionReply(term)
    const xtversionReply = await collect(term, XTVERSION_QUERY)
    expect(xtversionReply).toBe('')
    const da1Reply = await collect(term, DA1_QUERY)
    expect(da1Reply).not.toBe('')
  })

  it('masked terminal stays silent on the bare-form query too', async () => {
    const term = new Terminal({ allowProposedApi: true })
    suppressXtversionReply(term)
    const reply = await collect(term, XTVERSION_QUERY_BARE)
    expect(reply).toBe('')
  })
})
