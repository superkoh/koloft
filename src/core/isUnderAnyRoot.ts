import path from 'path'

export function isUnderAnyRoot(target: string, roots: readonly string[]): boolean {
  const file = path.resolve(target)
  return roots.some((raw) => {
    const root = path.resolve(raw)
    return file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  })
}
