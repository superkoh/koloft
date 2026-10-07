export const MYSELF = 'me'

export function slashCommandProblem(text: string): string | undefined {
  if (!text.startsWith('/')) return 'a command starts with a slash, like /compact.'
  if (/[\u0000-\u001f\u007f]/.test(text)) return 'a command is one line of plain text.'
  return undefined
}

export function didNotRun(problem: string): string {
  return `Koloft did not run it: ${problem}`
}

export function waitingForAnswer(name: string, text: string): string {
  return `${name} is waiting for an answer, so ${text} was not typed. Answer it first, then send the command again.`
}
