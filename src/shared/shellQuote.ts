/** single-quote a string for safe embedding in a shell command */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
