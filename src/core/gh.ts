export interface GhResult {
  code: number | null
  stdout: string
  stderr: string
  missing: boolean
}

export type Gh = (args: string[]) => Promise<GhResult>

export const GH_SIGNED_OUT = 4

export function slug(repo: { owner: string; repo: string }): string {
  return `${repo.owner}/${repo.repo}`
}

export function ghJsonArray(stdout: string): any[] | null {
  let v: unknown
  try {
    v = JSON.parse(stdout)
  } catch {
    return null
  }
  return Array.isArray(v) ? v : null
}
