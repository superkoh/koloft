import { stripTerminalCodes } from './terminalCodes'

const OUTPUT_START = ']7600;koloft-sign-in'
const OUTPUT_START_SEEN = `\x1b${OUTPUT_START}\x07`
export const MARK_OUTPUT_START = `printf '\\033${OUTPUT_START}\\007'`
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CONTROL_BUT_TAB = /[\x00-\x08\x0b-\x1f\x7f]/g
const KEPT_OUTPUT_MAX = 8192
const TAIL_LINES = 8

export class SignInOutput {
  private started = false
  private buf = ''

  feed(data: string): void {
    if (!this.started) {
      const seen = this.buf + data
      const at = seen.indexOf(OUTPUT_START_SEEN)
      if (at < 0) {
        this.buf = seen.slice(1 - OUTPUT_START_SEEN.length)
        return
      }
      this.started = true
      this.buf = ''
      data = seen.slice(at + OUTPUT_START_SEEN.length)
    }
    this.buf = (this.buf + data).slice(-KEPT_OUTPUT_MAX)
  }

  tail(): string {
    return stripTerminalCodes(this.buf.replace(OSC_SEQUENCE, ''))
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.slice(line.lastIndexOf('\r') + 1).replace(CONTROL_BUT_TAB, ''))
      .filter((line) => line.trim())
      .slice(-TAIL_LINES)
      .join('\n')
  }
}
