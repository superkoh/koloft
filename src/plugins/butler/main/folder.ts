import path from 'path'

// ADR-0029 CC§3 CODEX§2
export function conductorFolder(userData: string): string {
  return path.join(userData, 'conductors', 'global')
}
