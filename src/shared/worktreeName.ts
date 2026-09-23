export function isValidWorktreeName(name: string): boolean {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return false
  if (name.startsWith('.') || name.endsWith('.')) return false
  if (name.includes('..') || name.endsWith('.lock')) return false
  if (name.startsWith('-')) return false
  return true
}
