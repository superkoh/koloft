import { HANDOVER_OPENING, RESULT_PLACEHOLDER } from '@core/handOver'

const OLDER_SEND_MESSAGE_ENDING = 'with your SendMessage tool.'

// CC§9
const HANDOVER_THEN_TASK = new RegExp(
  `^(?:${HANDOVER_OPENING}[\\s\\S]*?${OLDER_SEND_MESSAGE_ENDING.replace('.', '\\.')}|[\\s\\S]*?koloft session send \\S+ ${RESULT_PLACEHOLDER})\\n\\n`
)

export function withoutHandover(text: string): string {
  return text.replace(HANDOVER_THEN_TASK, '')
}
