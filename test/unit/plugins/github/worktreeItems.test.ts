import { describe, it, expect, vi } from 'vitest'
import type { GithubOpenItems } from '../../../../src/shared/types'

let answer: GithubOpenItems | Error = { state: 'failed' }
vi.stubGlobal('window', {
  api: {
    github: {
      openItems: async () => {
        if (answer instanceof Error) throw answer
        return answer
      }
    }
  }
})

const { issueLaunch, itemLaunchExtras } =
  await import('../../../../src/plugins/github/renderer/worktreeItems')

const ISSUE = {
  kind: 'issue' as const,
  number: 218,
  title: 'Start a session from an issue',
  url: 'https://github.com/acme/app/issues/218',
  updatedAt: '2026-10-09T00:00:00Z'
}

describe('the issue ⌘P names, looked up among the open issues', () => {
  it('gives the issue’s title and link when it is open, and nothing when it is not listed or GitHub cannot be asked', async () => {
    answer = { state: 'items', repo: 'acme/app', issues: [ISSUE], prs: [] }
    expect(await issueLaunch('/repo', 218)).toEqual(itemLaunchExtras(ISSUE))
    expect(await issueLaunch('/repo', 9)).toBeNull()
    answer = { state: 'signed-out' }
    expect(await issueLaunch('/repo', 218)).toBeNull()
    answer = new Error('gh failed')
    expect(await issueLaunch('/repo', 218)).toBeNull()
  })
})
