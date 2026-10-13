import { describe, it, expect } from 'vitest'
import { HTTPS_REFUSED, rewriteRulesFor } from '../../src/main/gitSshRemotes'

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

describe('HTTPS_REFUSED', () => {
  it("matches GitLab's and Gitea's https-off answer as git prints it, and no other 403", () => {
    const fail = (body: string): string =>
      `remote: ${body}\nfatal: unable to access 'https://h/a/b.git/': The requested URL returned error: 403\n`
    expect(HTTPS_REFUSED.test(fail('Git access over HTTP is not allowed'))).toBe(true)
    expect(
      HTTPS_REFUSED.test(fail('Interacting with repositories by HTTP protocol is not allowed'))
    ).toBe(true)
    expect(HTTPS_REFUSED.test(fail('You are not allowed to push code to this project.'))).toBe(
      false
    )
  })
})
