import { describe, it, expect } from 'vitest'
import {
  gitAccountUrl,
  gitSignIn,
  sanitizeGitAccounts,
  sanitizeGitPicks
} from '../../src/shared/gitAccountOps'

const stored = (over: Record<string, unknown>): Record<string, unknown> => ({
  status: 'ok',
  addedAt: 1,
  default: false,
  ...over
})

describe('sanitizeGitAccounts', () => {
  it('upgrades a GitHub-only account saved before other hosts existed, author from its numeric id', () => {
    const [a] = sanitizeGitAccounts([
      {
        host: 'github.com',
        login: 'bob',
        id: 42,
        name: 'Bob B',
        default: true,
        status: 'ok',
        addedAt: 5
      }
    ])
    expect(a).toEqual({
      id: 'github.com/bob',
      platform: 'github',
      url: 'https://github.com',
      host: 'github.com',
      login: 'bob',
      author: { name: 'Bob B', email: '42+bob@users.noreply.github.com' },
      default: true,
      status: 'ok',
      addedAt: 5
    })
  })

  it('keeps one default per host: a GitHub and a GitLab account may both be default, a second on one host is not', () => {
    const out = sanitizeGitAccounts([
      stored({ platform: 'github', url: 'https://github.com', login: 'bob', default: true }),
      stored({ platform: 'github', url: 'https://github.com', login: 'alice', default: true }),
      stored({ platform: 'gitlab', url: 'https://gitlab.com', login: 'dev', default: true })
    ])
    expect(out.filter((a) => a.default).map((a) => a.id)).toEqual([
      'github.com/bob',
      'gitlab.com/dev'
    ])
  })

  it('a host with no default gets its first account as default', () => {
    const out = sanitizeGitAccounts([
      stored({ platform: 'gitea', url: 'https://codeberg.org', login: 'a' }),
      stored({ platform: 'gitea', url: 'https://codeberg.org', login: 'b' })
    ])
    expect(out.map((a) => a.default)).toEqual([true, false])
  })

  it('a GitLab login with a dot survives; an unknown platform or a broken URL does not', () => {
    const out = sanitizeGitAccounts([
      stored({ platform: 'gitlab', url: 'https://gitlab.example.com:8443/', login: 'dev.ops' }),
      stored({ platform: 'svn', url: 'https://x.com', login: 'x' }),
      stored({ platform: 'gitea', url: 'not a url at all', login: 'y' })
    ])
    expect(out.map((a) => [a.id, a.url])).toEqual([
      ['gitlab.example.com:8443/dev.ops', 'https://gitlab.example.com:8443']
    ])
  })
})

describe('sanitizeGitPicks', () => {
  it("keeps a pick's SSH key state and drops one it does not know", () => {
    const accounts = sanitizeGitAccounts([
      stored({ platform: 'gitea', url: 'https://codeberg.org', login: 'bob' })
    ])
    expect(
      sanitizeGitPicks(
        [
          { repo: '/r/a/.git', account: 'codeberg.org/bob', sshKey: 'works' },
          { repo: '/r/b/.git', account: 'codeberg.org/bob', sshKey: 'maybe' }
        ],
        accounts
      )
    ).toEqual([
      { repo: '/r/a/.git', account: 'codeberg.org/bob', sshKey: 'works' },
      { repo: '/r/b/.git', account: 'codeberg.org/bob' }
    ])
  })

  it('upgrades a {host, login} pick to the account id and drops a pick of an unknown account', () => {
    const accounts = sanitizeGitAccounts([
      stored({ platform: 'github', url: 'https://github.com', login: 'bob' })
    ])
    expect(
      sanitizeGitPicks(
        [
          { repo: '/r/a/.git', host: 'github.com', login: 'Bob' },
          { repo: '/r/b/.git', account: 'github.com/bob' },
          { repo: '/r/c/.git', account: 'github.com/eve' }
        ],
        accounts
      )
    ).toEqual([
      { repo: '/r/a/.git', account: 'github.com/bob' },
      { repo: '/r/b/.git', account: 'github.com/bob' }
    ])
  })
})

describe('gitAccountUrl', () => {
  it('GitLab with no address is gitlab.com; GitHub and Bitbucket ignore what was typed', () => {
    expect(gitAccountUrl('gitlab', '')).toBe('https://gitlab.com')
    expect(gitAccountUrl('github', 'https://elsewhere')).toBe('https://github.com')
    expect(gitAccountUrl('bitbucket', '')).toBe('https://bitbucket.org')
  })

  it('keeps the port, adds https when none is typed, and refuses what is not a server address', () => {
    expect(gitAccountUrl('gitea', 'http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000')
    expect(gitAccountUrl('ghes', 'ghe.example.com')).toBe('https://ghe.example.com')
    expect(gitAccountUrl('other', 'ftp://x.com')).toBeNull()
    expect(gitAccountUrl('other', 'https://u:p@x.com')).toBeNull()
    expect(gitAccountUrl('gitea', '')).toBeNull()
  })

  it('Azure DevOps needs exactly the organization in the address', () => {
    expect(gitAccountUrl('azure', 'https://dev.azure.com/acme')).toBe('https://dev.azure.com/acme')
    expect(gitAccountUrl('azure', 'https://dev.azure.com')).toBeNull()
    expect(gitAccountUrl('azure', 'https://dev.azure.com/acme/proj')).toBeNull()
  })
})

describe('gitSignIn', () => {
  it('says how each kind of server signs in', () => {
    expect(gitSignIn('github', 'https://github.com')).toBe('gh')
    expect(gitSignIn('ghes', 'https://ghe.example.com')).toBe('gh')
    expect(gitSignIn('ghes', 'https://ghe.example.com:8443')).toBe('token')
    expect(gitSignIn('gitlab', 'https://gitlab.com')).toBe('browser')
    expect(gitSignIn('gitlab', 'https://gitlab.example.com')).toBe('token')
    expect(gitSignIn('bitbucket', 'https://bitbucket.org')).toBe('browser')
    expect(gitSignIn('gitea', 'https://codeberg.org')).toBe('browser')
    expect(gitSignIn('azure', 'https://dev.azure.com/acme')).toBe('token')
    expect(gitSignIn('other', 'https://git.example.com')).toBe('token')
  })
})
