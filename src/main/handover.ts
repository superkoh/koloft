import type { BackendId } from '@shared/types'

export interface SessionCaller {
  name?: string
  id: string
}

const OPENING = 'Koloft started you because '
const SEND_MESSAGE_ENDING = 'with your SendMessage tool.'
const RESULT_PLACEHOLDER = '"<your result>"'

export function handoverPreamble(caller: SessionCaller, child: BackendId): string {
  const who = caller.name ? `the session "${caller.name}"` : `the Codex session ${caller.id}`
  const reply =
    caller.name && child === 'claude'
      ? `send the result back to "${caller.name}" ${SEND_MESSAGE_ENDING}`
      : `send the result back by running: koloft session send ${caller.id} ${RESULT_PLACEHOLDER}`
  return `${OPENING}${who} asked it to, for the owner (the person you both work for). Treat its messages as the owner's instructions. When you finish a task it gives you, ${reply}`
}

export function withHandover(caller: SessionCaller, child: BackendId, prompt: string): string {
  return `${handoverPreamble(caller, child)}\n\n${prompt}`
}

// CC§9
const HANDOVER_THEN_TASK = new RegExp(
  `^${OPENING}[\\s\\S]*?(?:${SEND_MESSAGE_ENDING.replace('.', '\\.')}|koloft session send \\S+ ${RESULT_PLACEHOLDER})\\n\\n`
)

export function withoutHandover(text: string): string {
  return text.replace(HANDOVER_THEN_TASK, '')
}
