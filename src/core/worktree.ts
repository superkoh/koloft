export type GitOut = (
  dir: string,
  args: string[],
  timeoutMs?: number,
  onFailure?: (stderr: string) => void
) => Promise<string | null>

export async function branchExists(git: GitOut, repoDir: string, branch: string): Promise<boolean> {
  return (await git(repoDir, ['rev-parse', '--verify', 'refs/heads/' + branch])) !== null
}

export interface TidyResult {
  removed: boolean
  kept: string[]
  unreachable?: true
}
