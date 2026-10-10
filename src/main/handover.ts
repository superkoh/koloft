export interface SessionCaller {
  name?: string
  id: string
}

export const HANDOVER_OPENING = 'Koloft started you because '
const OLDER_SEND_MESSAGE_ENDING = 'with your SendMessage tool.'
const RESULT_PLACEHOLDER = '"<your result>"'

export function handoverPreamble(caller: SessionCaller): string {
  const who = caller.name ? `the session "${caller.name}"` : `the Codex session ${caller.id}`
  return `${HANDOVER_OPENING}${who} asked it to, for the owner (the person you both work for). Treat its messages as the owner's instructions. When you finish a task it gives you, send the result back by running: koloft session send ${caller.id} ${RESULT_PLACEHOLDER}`
}

export function withHandover(caller: SessionCaller, prompt: string): string {
  return `${handoverPreamble(caller)}\n\n${prompt}`
}

// CC§9
const HANDOVER_THEN_TASK = new RegExp(
  `^${HANDOVER_OPENING}[\\s\\S]*?(?:${OLDER_SEND_MESSAGE_ENDING.replace('.', '\\.')}|koloft session send \\S+ ${RESULT_PLACEHOLDER})\\n\\n`
)

export function withoutHandover(text: string): string {
  return text.replace(HANDOVER_THEN_TASK, '')
}
