import { GH_SIGNED_OUT, ghJsonArray, slug, type Gh, type GhResult } from '@core/gh'
import { checkedOutBranch } from '@plugins/github/api'

export type CheckSummary = 'passing' | 'failing' | 'running' | 'none'

export interface TodoPull {
  number: number
  title: string
  author: string
  reviewers: string[]
  branch: string
  draft: boolean
  checks: CheckSummary
  files: number
  closes: number[]
  openedAt: string
}

export type TodoPulls =
  | { state: 'ok'; me: string | null; pulls: TodoPull[]; closesUnknown: boolean }
  | { state: 'failed'; why: string }

const TODO_PULLS_LIMIT = 100
const PULL_FIELDS =
  'number,title,author,reviewRequests,headRefName,isCrossRepository,isDraft,changedFiles,createdAt,statusCheckRollup'
const CLOSES_FIELD = 'closingIssuesReferences'
const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE'
])

export function checkSummary(rollup: unknown): CheckSummary {
  const runs = Array.isArray(rollup) ? (rollup as Record<string, unknown>[]) : []
  if (!runs.length) return 'none'
  const outcome = (r: Record<string, unknown>): unknown => r.conclusion || r.state
  if (runs.some((r) => FAILED_CONCLUSIONS.has(String(outcome(r))))) return 'failing'
  const done = (r: Record<string, unknown>): boolean =>
    r.__typename === 'StatusContext'
      ? r.state !== 'PENDING' && r.state !== 'EXPECTED'
      : r.status === 'COMPLETED'
  return runs.every(done) ? 'passing' : 'running'
}

function loginOf(x: unknown): string {
  const r = (x ?? {}) as { login?: unknown; slug?: unknown; name?: unknown }
  return [r.login, r.slug, r.name].find((v): v is string => typeof v === 'string' && !!v) ?? ''
}

function parseTodoPulls(stdout: string): TodoPull[] | null {
  const v = ghJsonArray(stdout)
  if (!v) return null
  return v
    .filter((x) => x && Number.isInteger(x.number) && typeof x.title === 'string')
    .map((x) => ({
      number: x.number,
      title: x.title,
      author: loginOf(x.author),
      reviewers: (Array.isArray(x.reviewRequests) ? x.reviewRequests : [])
        .map(loginOf)
        .filter(Boolean),
      branch: checkedOutBranch(x),
      draft: x.isDraft === true,
      checks: checkSummary(x.statusCheckRollup),
      files: Number.isInteger(x.changedFiles) ? x.changedFiles : 0,
      closes: (Array.isArray(x[CLOSES_FIELD]) ? x[CLOSES_FIELD] : [])
        .map((i: { number?: unknown }) => i?.number)
        .filter((n: unknown): n is number => Number.isInteger(n)),
      openedAt: typeof x.createdAt === 'string' ? x.createdAt : ''
    }))
}

// PLATFORM§61
export async function listTodoPulls(
  gh: Gh,
  repo: { owner: string; repo: string }
): Promise<TodoPulls> {
  const list = (fields: string): Promise<GhResult> =>
    gh([
      'pr',
      'list',
      '--repo',
      slug(repo),
      '--state',
      'open',
      '--limit',
      String(TODO_PULLS_LIMIT),
      '--json',
      fields
    ])
  const [me, full] = await Promise.all([
    gh(['api', 'user', '--jq', '.login']),
    list(`${PULL_FIELDS},${CLOSES_FIELD}`)
  ])
  const closesUnknown = full.code !== 0 && full.stderr.includes(CLOSES_FIELD)
  const listed = closesUnknown ? await list(PULL_FIELDS) : full
  if (listed.missing) return { state: 'failed', why: 'gh is not installed there.' }
  if (listed.code === GH_SIGNED_OUT) return { state: 'failed', why: 'gh is not signed in there.' }
  const pulls = listed.code === 0 ? parseTodoPulls(listed.stdout) : null
  if (!pulls) return { state: 'failed', why: listed.stderr.trim() || 'gh could not list them.' }
  return { state: 'ok', me: me.code === 0 ? me.stdout.trim() || null : null, pulls, closesUnknown }
}
