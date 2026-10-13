const CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g
const CHARSET_SWITCH = /\x1b[()][AB0]/g

export function stripTerminalCodes(s: string): string {
  return s.replace(CSI_SEQUENCE, '').replace(CHARSET_SWITCH, '')
}
