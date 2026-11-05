import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { copyOsc52ToClipboard } from '../../src/renderer/src/osc52'

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

async function copiedBy(input: string): Promise<{ copied: string[]; replied: string }> {
  const term = new Terminal({ allowProposedApi: true })
  const copied: string[] = []
  let replied = ''
  term.onData((d) => {
    replied += d
  })
  copyOsc52ToClipboard(term, (text) => copied.push(text))
  await new Promise<void>((resolve) => term.write(input, resolve))
  return { copied, replied }
}

describe('a program in the terminal sets the clipboard with OSC 52', () => {
  it('copies the decoded text, Chinese included', async () => {
    const { copied } = await copiedBy(`\x1b]52;c;${b64('远程复制 ok')}\x07`)
    expect(copied).toEqual(['远程复制 ok'])
  })

  it('copies what tmux load-buffer -w sends, whose first field is empty', async () => {
    const { copied } = await copiedBy(`\x1b]52;;${b64('from tmux')}\x1b\\`)
    expect(copied).toEqual(['from tmux'])
  })

  it('never answers a request to read the clipboard', async () => {
    const { copied, replied } = await copiedBy('\x1b]52;c;?\x07')
    expect(copied).toEqual([])
    expect(replied).toBe('')
  })

  it('ignores an empty or broken payload', async () => {
    const { copied } = await copiedBy('\x1b]52;c;\x07\x1b]52;c;@@@\x07\x1b]52\x07')
    expect(copied).toEqual([])
  })
})
