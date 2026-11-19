import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../../../../src/shared/types'
import { githubVerb } from '../../../../src/main/agentGithub'
import { failingChecksText, type GhResult } from '../../../../src/main/prChecks'

const REPO = { owner: 'acme', repo: 'widgets' }
const JOB_LINK = 'https://github.com/acme/widgets/actions/runs/1/job/22'

async function said(
  args: string[],
  over: { ok?: boolean; out?: string; butler?: boolean } = {}
): Promise<string> {
  const verb = githubVerb({
    run: async () => ({ ok: over.ok ?? true, out: over.out ?? 'OPEN' }),
    writesInEnglishOnly: () => over.butler ?? false
  })
  const reply = await verb(args, { tabId: 'pty-1', cwd: '/ws/app', session: {} as SessionInfo })
  return `$ koloft gh ${args.join(' ')}${over.butler ? '  (butler)' : ''}\n  exit ${reply.exit}: ${reply.text}`
}

const answer = (code: number, stdout = '', stderr = ''): GhResult => ({
  code,
  stdout,
  stderr,
  missing: false
})

describe('the full text of koloft gh and of a failing check, pinned so that moving them changes no character', () => {
  it('what the agent hears from koloft gh, for each refusal and for what gh said', async () => {
    const lines = [
      await said([]),
      await said(['--help']),
      await said(['auth', 'token']),
      await said(['api', 'user', '--jq', 'env.GH_TOKEN']),
      await said(['pr', 'checkout', '1', '--', '--depth=1']),
      await said(['issue', 'create', '--title', '修好登录'], { butler: true }),
      await said(['pr', 'view', '389'], { ok: false, out: 'no pull requests found' }),
      await said(['pr', 'view', '389'], { out: 'title:\tFix login\n' })
    ]
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./text/gh-replies.txt')
  })

  it('what the agent is handed for a pull request whose check failed', async () => {
    const text = await failingChecksText(
      async (args) =>
        args[0] === 'pr'
          ? answer(
              0,
              JSON.stringify([{ name: 'test', bucket: 'fail', link: JOB_LINK, workflow: 'CI' }])
            )
          : answer(0, 'test\tRun npm test\t2026-10-07T13:25:40.2831910Z ##[error]boom\n'),
      REPO,
      7
    )
    await expect(text).toMatchFileSnapshot('./text/failing-checks.txt')
  })
})
