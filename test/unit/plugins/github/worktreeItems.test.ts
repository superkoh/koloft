import { describe, it, expect, vi } from 'vitest'
import type { GithubItem, GithubOpenItems } from '../../../../src/shared/types'
import {
  isDimmed,
  itemAim,
  pendingLaunch,
  primaryLabel,
  seededItemExtras,
  worktreeBaseMode
} from '../../../../src/renderer/src/newSession'

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

const { issueLaunch, itemLaunchExtras, worktreeItem } =
  await import('../../../../src/plugins/github/renderer/worktreeItems')

const wt = (name: string): { name: string; dir: string; branch?: string } => ({
  name,
  dir: `/repo/.claude/worktrees/${name}`,
  branch: `worktree-${name}`
})

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

describe('itemAim (#218 — where an issue or pull request session starts)', () => {
  const issueOnGithub: GithubItem = {
    kind: 'issue',
    number: 218,
    title: 'Start a session from an issue',
    url: 'https://github.com/acme/app/issues/218',
    updatedAt: '2026-10-09T00:00:00Z'
  }
  const prOnGithub: GithubItem = {
    kind: 'pr',
    number: 329,
    title: 'Fix the restart',
    url: 'https://github.com/acme/app/pull/329',
    updatedAt: '2026-10-09T00:00:00Z',
    branch: 'fix/190-restart'
  }
  const issue = worktreeItem('/repo', issueOnGithub)
  const pr = worktreeItem('/repo', prOnGithub)
  const onPrBranch = { name: 'fix-190', dir: '/repo/.claude/worktrees/fix-190', branch: pr.branch }

  it('makes issue-<n> from the repo root the first time, and opens it when it is already there', () => {
    expect(itemAim(issue, [wt('alpha')])).toEqual({
      kind: 'item',
      item: issue,
      name: 'issue-218',
      dir: null
    })
    expect(worktreeBaseMode(itemAim(issue, [wt('alpha')]))).toBe('create')
    expect(itemAim(issue, [wt('issue-218')])).toMatchObject({
      name: 'issue-218',
      dir: '/repo/.claude/worktrees/issue-218'
    })
  })

  it("opens the worktree already on a pull request's branch, else its pr-<n>, else makes pr-<n> — never from main's HEAD", () => {
    expect(itemAim(pr, [wt('pr-329'), onPrBranch])).toMatchObject({
      name: 'fix-190',
      dir: onPrBranch.dir
    })
    expect(itemAim(pr, [wt('pr-329')])).toMatchObject({ name: 'pr-329' })
    const fresh = itemAim(pr, [wt('alpha')])
    expect(fresh).toMatchObject({ name: 'pr-329', dir: null })
    expect(worktreeBaseMode(fresh)).toBe('existing')
  })

  it('names the session after the issue and sends only its title and link, asking the agent to read the rest itself', () => {
    const extras = itemLaunchExtras(issueOnGithub)
    expect(extras.name).toBe('#218 Start a session from an issue')
    expect(extras.trustFolder).toBe(true)
    const lines = extras.firstPrompt!.split('\n')
    expect(lines.slice(0, 2)).toEqual([
      '#218 Start a session from an issue',
      'https://github.com/acme/app/issues/218'
    ])
    expect(extras.firstPrompt).toMatch(/gh issue view 218 --comments/)
    expect(itemLaunchExtras(prOnGithub).firstPrompt).toMatch(/gh pr view 329 --comments/)
  })

  it('the full first message an agent gets for an issue, a pull request and an issue picked from ⌘P, pinned so that moving it changes no character', async () => {
    const text = [
      `== issue\n${itemLaunchExtras(issueOnGithub).firstPrompt}`,
      `== pull request\n${itemLaunchExtras(prOnGithub).firstPrompt}`,
      `== issue from ⌘P\n${seededItemExtras(issue.launch, '  and add a test  ', 'Login test').firstPrompt}`
    ].join('\n')
    await expect(text + '\n').toMatchFileSnapshot('./text/first-prompts.txt')
  })

  it('from ⌘P, puts the issue first, then a blank line, then what was typed, and takes the typed title over the issue', () => {
    const extras = seededItemExtras(issue.launch, '  and add a test  ', 'Login test')
    expect(extras.firstPrompt).toBe(
      `${itemLaunchExtras(issueOnGithub).firstPrompt}\n\nand add a test`
    )
    expect(extras.name).toBe('Login test')
    expect(extras.trustFolder).toBe(true)
    expect(seededItemExtras(issue.launch, ' ', '')).toEqual(itemLaunchExtras(issueOnGithub))
  })

  it('⌘P starts where Assist pointed: the main checkout of a folder that is not git, a new worktree, or a new worktree for the issue with its lines first; a worktree that already exists is never reused, its name gets the next free -N', () => {
    const said = { prompt: ' fix login ', title: 'Login fix' }
    const typed = { firstPrompt: 'fix login', name: 'Login fix' }
    const listed = [wt('auth'), wt('issue-218')]
    expect(pendingLaunch('/repo', { kind: 'main' }, said, listed, null)).toEqual({
      cwd: '/repo',
      ...typed
    })
    expect(pendingLaunch('/repo', { kind: 'new', name: 'login' }, said, listed, null)).toEqual({
      cwd: '/repo',
      worktree: 'login',
      ...typed
    })
    expect(pendingLaunch('/repo', { kind: 'new', name: 'auth' }, said, listed, null)).toEqual({
      cwd: '/repo',
      worktree: 'auth-2',
      ...typed
    })
    expect(pendingLaunch('/repo', { kind: 'issue', number: 218 }, said, [], issue.launch)).toEqual({
      cwd: '/repo',
      worktree: 'issue-218',
      ...seededItemExtras(issue.launch, ' fix login ', 'Login fix')
    })
    expect(
      pendingLaunch('/repo', { kind: 'issue', number: 218 }, said, listed, issue.launch)
    ).toEqual({
      cwd: '/repo',
      worktree: 'issue-218-2',
      ...seededItemExtras(issue.launch, ' fix login ', 'Login fix')
    })
    expect(pendingLaunch('/repo', { kind: 'issue', number: 9 }, said, [], null)).toEqual({
      cwd: '/repo',
      worktree: 'issue-9',
      ...typed
    })
  })

  it('pictures pasted in ⌘P go last in the first prompt, one "Picture:" line each after a blank line, also behind an issue’s lines; with no pictures the prompt is as typed', () => {
    const pictures = [
      { path: '/pics/a.png', shown: 'blob:a' },
      { path: '/pics/b.jpg', shown: 'blob:b' }
    ]
    const said = { prompt: ' fix login ', title: '', pictures }
    const sent = 'fix login\n\nPicture: /pics/a.png\nPicture: /pics/b.jpg'
    expect(pendingLaunch('/repo', { kind: 'main' }, said, [], null).firstPrompt).toBe(sent)
    expect(
      pendingLaunch('/repo', { kind: 'issue', number: 218 }, said, [], issue.launch).firstPrompt
    ).toBe(`${itemLaunchExtras(issueOnGithub).firstPrompt}\n\n${sent}`)
    expect(
      pendingLaunch('/repo', { kind: 'main' }, { ...said, pictures: [] }, [], null).firstPrompt
    ).toBe('fix login')
  })

  it('labels the primary with the number it acts on', () => {
    expect(
      primaryLabel('start', { verb: 'Create', name: 'issue-218', itemRef: '#218' }, 'Claude')
    ).toBe('Create from #218 · Claude')
    expect(primaryLabel('pull', { verb: 'Create', name: 'issue-218', itemRef: '#218' })).toBe(
      'Pull & Create from #218'
    )
    expect(primaryLabel('start', { verb: 'Open', name: 'fix-190', itemRef: '#329' }, 'Codex')).toBe(
      'Open fix-190 for #329 · Codex'
    )
  })

  it('lets a typed word find a pull request by its branch as well as by number and title', () => {
    expect(isDimmed(pr.filterText, '190')).toBe(false)
    expect(isDimmed(pr.filterText, '#329')).toBe(false)
    expect(isDimmed(issue.filterText, '190')).toBe(true)
  })
})
