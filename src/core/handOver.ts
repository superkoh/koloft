export const HANDOVER_OPENING = 'Koloft started you because '
export const RESULT_PLACEHOLDER = '"<your result>"'

export function withHandover(preamble: string, prompt: string): string {
  return `${preamble}\n\n${prompt}`
}
