import type { Terminal } from '@xterm/xterm'

// CC§12
export function suppressXtversionReply(term: Terminal): void {
  term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => true)
}
