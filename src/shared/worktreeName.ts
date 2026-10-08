export function isValidWorktreeName(name: string): boolean {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return false
  if (name.startsWith('.') || name.endsWith('.')) return false
  if (name.includes('..') || name.endsWith('.lock')) return false
  if (name.startsWith('-')) return false
  return true
}

const PORT_OFFSETS = 99

export function portOffset(worktreeName: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < worktreeName.length; i++) {
    hash ^= worktreeName.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash % PORT_OFFSETS) + 1
}
