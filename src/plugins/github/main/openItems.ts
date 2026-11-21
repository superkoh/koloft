import { GH_SIGNED_OUT, ghJsonArray, slug, type Gh, type GhResult } from '@core/gh'
import type { GithubItem, GithubOpenItems } from '@shared/types'
import type { GithubRepo } from '@shared/githubUrl'

const OPEN_ITEMS_LIMIT = 50

export function checkedOutBranch(pr: {
  number: number
  isCrossRepository?: unknown
  headRefName?: unknown
}): string {
  return pr.isCrossRepository === true ? `pr-${pr.number}` : String(pr.headRefName ?? '')
}

function itemsOf(stdout: string, kind: GithubItem['kind']): GithubItem[] | null {
  const v = ghJsonArray(stdout)
  if (!v) return null
  return v
    .filter(
      (x) =>
        x &&
        Number.isInteger(x.number) &&
        typeof x.title === 'string' &&
        typeof x.url === 'string' &&
        typeof x.updatedAt === 'string' &&
        (kind === 'issue' || typeof x.headRefName === 'string')
    )
    .map((x) => ({
      kind,
      number: x.number,
      title: x.title,
      url: x.url,
      updatedAt: x.updatedAt,
      ...(kind === 'pr' ? { branch: checkedOutBranch(x) } : {})
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// PLATFORM§32
function parseOpenItems(repo: string, issues: GhResult, prs: GhResult): GithubOpenItems {
  if (issues.missing || prs.missing) return { state: 'no-gh' }
  if (issues.code === GH_SIGNED_OUT || prs.code === GH_SIGNED_OUT) return { state: 'signed-out' }
  const i = itemsOf(issues.stdout, 'issue')
  const p = itemsOf(prs.stdout, 'pr')
  return i && p ? { state: 'items', repo, issues: i, prs: p } : { state: 'failed' }
}

export async function listOpenItems(gh: Gh, repo: GithubRepo): Promise<GithubOpenItems> {
  const list = (what: 'issue' | 'pr', fields: string): Promise<GhResult> =>
    gh([
      what,
      'list',
      '--repo',
      slug(repo),
      '--state',
      'open',
      '--limit',
      String(OPEN_ITEMS_LIMIT),
      '--json',
      fields
    ])
  const [issues, prs] = await Promise.all([
    list('issue', 'number,title,url,updatedAt'),
    list('pr', 'number,title,url,updatedAt,headRefName,isCrossRepository')
  ])
  return parseOpenItems(slug(repo), issues, prs)
}
