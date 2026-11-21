import { describe, it, expect } from 'vitest'
import type { Gh, GhResult } from '../../../../src/core/gh'
import { checkSummary, listTodoPulls } from '../../../../src/plugins/todo/main/pulls'

describe('the open pull requests koloft todo lists', () => {
  const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '', missing: false })
  const PR = {
    number: 41,
    title: 'Bump vite',
    author: { login: 'alice' },
    reviewRequests: [{ login: 'bob' }, { slug: 'web-team' }],
    headRefName: 'bump-vite',
    isCrossRepository: false,
    isDraft: false,
    changedFiles: 2,
    createdAt: '2026-10-17T00:00:00Z',
    closingIssuesReferences: [{ number: 12 }],
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }
    ]
  }

  it('reads who opened each one, whom it asks to review, its checks, size and the issues it closes, and who the account is', async () => {
    const asked: string[][] = []
    const gh: Gh = async (args) => {
      asked.push(args)
      return args[0] === 'api' ? ok('alice\n') : ok(JSON.stringify([PR]))
    }
    expect(await listTodoPulls(gh, { owner: 'octo', repo: 'shop' })).toEqual({
      state: 'ok',
      me: 'alice',
      closesUnknown: false,
      pulls: [
        {
          number: 41,
          title: 'Bump vite',
          author: 'alice',
          reviewers: ['bob', 'web-team'],
          branch: 'bump-vite',
          draft: false,
          checks: 'passing',
          files: 2,
          closes: [12],
          openedAt: '2026-10-17T00:00:00Z'
        }
      ]
    })
    expect(asked.find((a) => a[0] === 'pr')).toEqual(
      expect.arrayContaining(['--repo', 'octo/shop'])
    )
  })

  // PLATFORM§61
  it('with a gh too old to know which issues a pull request closes, lists them again without that and says so', async () => {
    const gh: Gh = async (args) => {
      if (args[0] === 'api') return ok('alice')
      if (args.at(-1)?.includes('closingIssuesReferences'))
        return {
          code: 1,
          stdout: '',
          stderr: 'Unknown JSON field: "closingIssuesReferences"',
          missing: false
        }
      return ok(JSON.stringify([{ ...PR, closingIssuesReferences: undefined }]))
    }
    expect(await listTodoPulls(gh, { owner: 'octo', repo: 'shop' })).toMatchObject({
      state: 'ok',
      closesUnknown: true,
      pulls: [{ number: 41, closes: [] }]
    })
  })

  it('sums up checks as failing when any failed, running while any is unfinished, passing when all are done, none when there are none', () => {
    expect(checkSummary([])).toBe('none')
    expect(
      checkSummary([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }
      ])
    ).toBe('failing')
    expect(checkSummary([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe('running')
    expect(checkSummary([{ __typename: 'StatusContext', state: 'SUCCESS' }])).toBe('passing')
  })
})
