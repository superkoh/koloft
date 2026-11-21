import { describe, it, expect } from 'vitest'
import { GH_SIGNED_OUT, type Gh, type GhResult } from '../../src/core/gh'
import { GithubRepos } from '../../src/main/githubRepos'

const SHA = '1111111111111111111111111111111111111111'
const root = '/work/widgets'

function make(opts: { gh?: Gh; remote?: string } = {}): GithubRepos {
  const remote = opts.remote ?? 'remote.origin.url git@github.com:acme/widgets.git\n'
  return new GithubRepos({
    git: async (_root, args) => (args.includes('--get-regexp') ? remote : null),
    ...(opts.gh && { gh: (args) => opts.gh!(args) })
  })
}

describe('GithubRepos.mergedHeads', () => {
  const ghAnswering =
    (r: Partial<GhResult>, asked: string[][] = []): Gh =>
    async (args) => {
      asked.push(args)
      return { code: 0, stdout: '[]', stderr: '', missing: false, ...r }
    }

  it('names the head commit of each merged pull request from the branch', async () => {
    const asked: string[][] = []
    const gh = ghAnswering(
      {
        stdout: JSON.stringify([
          { headRefName: 'fix/login', headRefOid: SHA },
          { headRefName: 'fix/login', headRefOid: 7 }
        ])
      },
      asked
    )
    expect(await make({ gh }).mergedHeads(root, 'fix/login')).toEqual([SHA])
    expect(asked).toEqual([
      [
        'pr',
        'list',
        '--repo',
        'acme/widgets',
        '--state',
        'merged',
        '--head',
        'fix/login',
        '--json',
        'headRefName,headRefOid'
      ]
    ])
  })

  it('a repository not on GitHub has no merged pull request, and gh is never asked', async () => {
    const asked: string[][] = []
    const gitlab = 'remote.origin.url git@gitlab.com:acme/widgets.git\n'
    expect(
      await make({ gh: ghAnswering({}, asked), remote: gitlab }).mergedHeads(root, 'x')
    ).toEqual([])
    expect(asked).toHaveLength(0)
  })

  it('a gh that fails or is missing cannot say', async () => {
    const heads = (r: Partial<GhResult>): Promise<string[] | null> =>
      make({ gh: ghAnswering(r) }).mergedHeads(root, 'x')
    expect(await heads({ code: GH_SIGNED_OUT, stdout: '' })).toBeNull()
    expect(await heads({ code: null, missing: true, stdout: '' })).toBeNull()
  })

  it('by branch: one list of the repository’s merged pull requests names each branch’s head commits; a failed gh cannot say', async () => {
    const asked: string[][] = []
    const gh = ghAnswering(
      {
        stdout: JSON.stringify([
          { headRefName: 'fix/login', headRefOid: SHA },
          { headRefName: 'fix/login', headRefOid: 'b'.repeat(40) },
          { headRefName: 'docs', headRefOid: 7 }
        ])
      },
      asked
    )
    expect(await make({ gh }).mergedHeadsByBranch(root)).toEqual(
      new Map([['fix/login', [SHA, 'b'.repeat(40)]]])
    )
    expect(asked).toHaveLength(1)
    expect(asked[0]).toEqual(
      expect.arrayContaining(['--state', 'merged', '--repo', 'acme/widgets'])
    )
    expect(
      await make({ gh: ghAnswering({ code: GH_SIGNED_OUT, stdout: '' }) }).mergedHeadsByBranch(root)
    ).toBeNull()
  })
})
