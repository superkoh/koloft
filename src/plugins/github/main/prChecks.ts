import { GH_SIGNED_OUT, ghJsonArray, slug, type Gh, type GhResult } from '@core/gh'
import type { PrCheck, PrCheckBucket, PrChecks } from '@shared/types'
import type { GithubRepo } from '@shared/githubUrl'
import { stripTerminalCodes } from '@core/terminalCodes'

export const FAILED_LOG_LIMIT = 6000
const LINES_KEPT_AFTER_FIRST_ERROR = 3
const BUCKETS: readonly PrCheckBucket[] = ['pass', 'fail', 'pending', 'skipping', 'cancel']

function checksOf(stdout: string): PrCheck[] | null {
  const v = ghJsonArray(stdout)
  if (!v) return null
  return v.flatMap((c) =>
    c && typeof c.name === 'string' && BUCKETS.includes(c.bucket)
      ? [
          {
            name: c.name,
            bucket: c.bucket,
            link: typeof c.link === 'string' ? c.link : '',
            workflow: typeof c.workflow === 'string' ? c.workflow : ''
          }
        ]
      : []
  )
}

// PLATFORM§32
export function parseChecks(r: GhResult): PrChecks {
  if (r.missing) return { state: 'no-gh' }
  const checks = checksOf(r.stdout)
  if (checks) return { state: 'ok', checks }
  if (r.code === GH_SIGNED_OUT) return { state: 'signed-out' }
  if (/^no checks reported/m.test(r.stderr)) return { state: 'ok', checks: [] }
  if (/no pull requests found|Could not resolve to a PullRequest/.test(r.stderr)) {
    return { state: 'no-pr' }
  }
  return { state: 'failed' }
}

export async function prChecks(gh: Gh, repo: GithubRepo, pr: number): Promise<PrChecks> {
  return parseChecks(
    await gh([
      'pr',
      'checks',
      String(pr),
      '--repo',
      slug(repo),
      '--json',
      'name,bucket,link,workflow'
    ])
  )
}

export function jobIdOf(link: string): string | null {
  return /\/actions\/runs\/\d+\/job\/(\d+)/.exec(link)?.[1] ?? null
}

// PLATFORM§32
const LOG_LINE_PREFIX = /^[^\t\n]*\t[^\t\n]*\t﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/

export function trimFailedLog(raw: string, limit = FAILED_LOG_LIMIT): string {
  const lines = raw
    .split('\n')
    .map((l) => stripTerminalCodes(l.replace(LOG_LINE_PREFIX, '')).trimEnd())
  const firstError = lines.findIndex((l) => l.startsWith('##[error]'))
  let end = firstError < 0 ? lines.length : firstError + 1 + LINES_KEPT_AFTER_FIRST_ERROR
  end = Math.min(end, lines.length)
  while (end > 0 && lines[end - 1] === '') end--
  const kept: string[] = []
  let size = 0
  for (let i = end - 1; i >= 0; i--) {
    const cost = lines[i].length + 1
    if (size + cost > limit) break
    kept.unshift(lines[i])
    size += cost
  }
  return kept.join('\n')
}

function checkBlock(check: PrCheck, repo: GithubRepo, pr: number, excerpt: string): string {
  const from = check.workflow ? ` (workflow ${check.workflow})` : ''
  const lines = [
    `CI check "${check.name}"${from} failed on pull request #${pr} of ${slug(repo)}.`,
    `Full log: ${check.link}`
  ]
  if (excerpt) lines.push('', '--- log excerpt (around the first error) ---', excerpt)
  return lines.join('\n')
}

export async function failingChecksText(
  gh: Gh,
  repo: GithubRepo,
  pr: number
): Promise<string | null> {
  const found = await prChecks(gh, repo, pr)
  if (found.state !== 'ok') return null
  const failing = found.checks.filter((c) => c.bucket === 'fail')
  if (failing.length === 0) return null
  const blocks = await Promise.all(
    failing.map(async (check) => {
      const job = jobIdOf(check.link)
      const log = job
        ? await gh(['run', 'view', '--job', job, '--repo', slug(repo), '--log-failed'])
        : null
      return checkBlock(check, repo, pr, log?.code === 0 ? trimFailedLog(log.stdout) : '')
    })
  )
  return blocks.join('\n\n') + '\n\n'
}
