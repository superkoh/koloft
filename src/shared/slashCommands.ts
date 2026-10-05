export const MYSELF = 'me'

export function slashCommandProblem(text: string): string | undefined {
  if (!text.startsWith('/')) return 'a command starts with a slash, like /compact.'
  if (/[\u0000-\u001f\u007f]/.test(text)) return 'a command is one line of plain text.'
  return undefined
}
