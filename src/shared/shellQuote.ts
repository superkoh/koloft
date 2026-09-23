export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
