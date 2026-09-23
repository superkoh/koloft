import { describe, it, expect } from 'vitest'
import {
  loginUrlFor,
  parseGithubRemote,
  pickRemoteUrl,
  prNumbersByBranch,
  pullsUrlOf,
  repoUrlOf
} from '@shared/githubUrl'

describe('parseGithubRemote', () => {
  it('reads the four spellings git accepts', () => {
    const want = { owner: 'acme', repo: 'widgets' }
    expect(parseGithubRemote('git@github.com:acme/widgets.git')).toEqual(want)
    expect(parseGithubRemote('https://github.com/acme/widgets.git')).toEqual(want)
    expect(parseGithubRemote('ssh://git@github.com/acme/widgets')).toEqual(want)
    expect(parseGithubRemote('git://github.com/acme/widgets')).toEqual(want)
  })

  it('ignores a trailing slash, a missing .git and the host case', () => {
    const want = { owner: 'acme', repo: 'widgets' }
    expect(parseGithubRemote('https://GitHub.com/acme/widgets/')).toEqual(want)
    expect(parseGithubRemote('https://www.github.com/acme/widgets')).toEqual(want)
    expect(parseGithubRemote('git@GITHUB.COM:acme/widgets.git')).toEqual(want)
  })

  it('refuses anything that is not github.com', () => {
    expect(parseGithubRemote('git@gitlab.com:acme/widgets.git')).toBeNull()
    expect(parseGithubRemote('https://github.example.com/acme/widgets.git')).toBeNull()
    expect(parseGithubRemote('https://github.com.evil.test/acme/widgets')).toBeNull()
    expect(parseGithubRemote('/srv/git/widgets.git')).toBeNull()
    expect(parseGithubRemote('')).toBeNull()
  })

  it('refuses a path that is not exactly owner/repo', () => {
    expect(parseGithubRemote('https://github.com/superkoh')).toBeNull()
    expect(parseGithubRemote('https://github.com/acme/widgets/tree/main')).toBeNull()
  })
})

describe('pickRemoteUrl', () => {
  const line = (name: string, url: string): string => `remote.${name}.url ${url}\n`

  it('prefers origin', () => {
    const out =
      line('upstream', 'git@github.com:a/b.git') + line('origin', 'git@github.com:c/d.git')
    expect(pickRemoteUrl(out)).toBe('git@github.com:c/d.git')
  })

  it('takes the only remote when it is not called origin', () => {
    expect(pickRemoteUrl(line('gh', 'git@github.com:a/b.git'))).toBe('git@github.com:a/b.git')
  })

  it('gives up on two remotes with no origin', () => {
    const out = line('upstream', 'git@github.com:a/b.git') + line('fork', 'git@github.com:c/d.git')
    expect(pickRemoteUrl(out)).toBeNull()
  })

  it('survives a remote name with dots in it, and empty output', () => {
    expect(pickRemoteUrl(line('my.remote', 'git@github.com:a/b.git'))).toBe(
      'git@github.com:a/b.git'
    )
    expect(pickRemoteUrl('')).toBeNull()
  })
})

describe('prNumbersByBranch', () => {
  const SHA_A = '1111111111111111111111111111111111111111'
  const SHA_B = '2222222222222222222222222222222222222222'
  const out = [
    `${SHA_A}\trefs/heads/feature`,
    `${SHA_B}\trefs/heads/main`,
    `${SHA_A}\trefs/pull/265/head`,
    `${SHA_B}\trefs/pull/12/head`,
    `${SHA_A}\trefs/pull/265/merge`
  ].join('\n')

  it('matches a branch to its pull request by commit, never reading a merge ref as a branch', () => {
    const m = prNumbersByBranch(out)
    expect(m.get('feature')).toBe(265)
    expect(m.get('main')).toBe(12)
  })

  it('says nothing about a branch that is not on the remote', () => {
    expect(prNumbersByBranch(out).get('never-pushed')).toBeUndefined()
    expect(prNumbersByBranch('').size).toBe(0)
  })

  it('takes the highest number when one commit has several', () => {
    const many = [
      `${SHA_A}\trefs/heads/feature`,
      `${SHA_A}\trefs/pull/9/head`,
      `${SHA_A}\trefs/pull/265/head`,
      `${SHA_A}\trefs/pull/77/head`
    ].join('\n')
    expect(prNumbersByBranch(many).get('feature')).toBe(265)
  })

  it('reads a branch name that has slashes in it', () => {
    const slashed = [`${SHA_A}\trefs/heads/user/fix/login`, `${SHA_A}\trefs/pull/3/head`].join('\n')
    expect(prNumbersByBranch(slashed).get('user/fix/login')).toBe(3)
  })
})

describe('urls', () => {
  const r = { owner: 'acme', repo: 'widgets' }

  it('builds the repository and pull-request-list addresses', () => {
    expect(repoUrlOf(r)).toBe('https://github.com/acme/widgets')
    expect(pullsUrlOf(r)).toBe('https://github.com/acme/widgets/pulls')
  })

  // PLATFORM§32
  it('wraps a target into the login page', () => {
    expect(loginUrlFor('https://github.com/acme/widgets/pull/265')).toBe(
      'https://github.com/login?return_to=%2Facme%2Fwidgets%2Fpull%2F265'
    )
    expect(loginUrlFor('https://github.com/acme/widgets/pulls?q=is%3Aopen')).toBe(
      'https://github.com/login?return_to=%2Facme%2Fwidgets%2Fpulls%3Fq%3Dis%253Aopen'
    )
  })
})
