import { describe, expect, it } from 'vitest'
import { MARK_OUTPUT_START, SignInOutput } from '../../src/main/signInOutput'
import { execFileSync } from 'child_process'

const printedMark = execFileSync('/bin/sh', ['-c', MARK_OUTPUT_START], { encoding: 'utf8' })

describe('the text a sign-in tab shows back in Settings ▸ Accounts', () => {
  it('leaves out the prompt and the typed command, which echo before the CLI prints anything', () => {
    const out = new SignInOutput()
    out.feed(`me@Mac ~ % ${MARK_OUTPUT_START}; exec env CODEX_HOME=/h codex login\r\n`)
    out.feed(`${printedMark}Error: the device code expired\r\n`)
    expect(out.tail()).toBe('Error: the device code expired')
  })

  it('still finds where the CLI starts when the terminal hands that over in two pieces', () => {
    const out = new SignInOutput()
    out.feed(`me@Mac ~ % ${printedMark.slice(0, 9)}`)
    out.feed(`${printedMark.slice(9)}Error: the device code expired\r\n`)
    expect(out.tail()).toBe('Error: the device code expired')
  })

  it('shows plain text: colours, titles and links dropped, a line redrawn in place shows its last text', () => {
    const out = new SignInOutput()
    out.feed(printedMark)
    out.feed(
      '\x1b]0;codex\x07\x1b[31mWaiting…\rFailed:\x1b[0m \x1b]8;;https://x\x07help\x1b]8;;\x07\r\n'
    )
    expect(out.tail()).toBe('Failed: help')
  })
})
