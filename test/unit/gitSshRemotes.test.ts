import { describe, it, expect } from 'vitest'
import { httpsTurnedAway, rewriteRulesFor } from '../../src/main/gitSshRemotes'

const sameHost = async (dest: string): Promise<string> => dest.replace(/^.*@/, '')

describe('rewriteRulesFor', () => {
  it("an Azure DevOps SSH remote goes to its organization's _git address, and one in another organization is left alone", async () => {
    const azure = { platform: 'azure' as const, url: 'https://dev.azure.com/acme' }
    const mine = 'git@ssh.dev.azure.com:v3/acme/proj/app'
    const theirs = 'git@ssh.dev.azure.com:v3/other/proj/app'
    const { rules } = await rewriteRulesFor(azure, [mine, theirs], sameHost)
    expect(rules).toContainEqual(['https://dev.azure.com/acme/proj/_git/app', mine])
    expect(rules).toContainEqual([
      'https://dev.azure.com/acme/proj/_git/',
      'git@ssh.dev.azure.com:v3/acme/proj/'
    ])
    expect(rules.some(([, from]) => from.includes('/other/'))).toBe(false)
  })

  it("a server under a sub-path with SSH on its own port maps to the account's address with that path", async () => {
    const gitea = { platform: 'gitea' as const, url: 'https://git.example/forge' }
    const url = 'ssh://git@git.example:2222/acme/app.git'
    const found = await rewriteRulesFor(gitea, [url], sameHost)
    expect(found.rules).toContainEqual(['https://git.example/forge/acme/app.git', url])
    expect(found.ssh).toEqual({ url, dest: 'git@git.example', port: '2222' })
  })

  it('an account on any other server rewrites nothing', async () => {
    const other = { platform: 'other' as const, url: 'https://git.example' }
    expect(await rewriteRulesFor(other, ['git@git.example:acme/app.git'], sameHost)).toEqual({
      rules: []
    })
  })
})

describe('httpsTurnedAway', () => {
  const forbidden = (body: string): string =>
    `remote: ${body}\nfatal: unable to access 'https://h/a/b.git/': The requested URL returned error: 403\n`

  it("names GitLab's and Gitea's https-off answer as SSH only", () => {
    expect(httpsTurnedAway(forbidden('Git access over HTTP is not allowed'))).toBe('ssh-only')
    expect(
      httpsTurnedAway(forbidden('Interacting with repositories by HTTP protocol is not allowed'))
    ).toBe('ssh-only')
  })

  it('a 403 with words it does not know still means the server turned https away', () => {
    expect(httpsTurnedAway(forbidden('HTTP access is switched off on this instance'))).toBe(
      'forbidden'
    )
  })

  it('a rejected sign-in, a missing repository and an unreachable server are not https turned away', () => {
    expect(
      httpsTurnedAway(
        "remote: HTTP Basic: Access denied. If a password was provided for Git authentication, the password was incorrect or you're required to use a token instead of a password.\nfatal: Authentication failed for 'https://h/a/b.git/'\n"
      )
    ).toBeNull()
    expect(
      httpsTurnedAway(
        "remote: Repository not found.\nfatal: repository 'https://h/a/b.git/' not found\n"
      )
    ).toBeNull()
    expect(
      httpsTurnedAway("fatal: unable to access 'https://h/a/b.git/': Could not resolve host: h\n")
    ).toBeNull()
  })
})
