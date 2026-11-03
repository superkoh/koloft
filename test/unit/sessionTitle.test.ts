import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { titleForTask } from '../../src/main/sessionTitle'
import { koloftAssist } from '../../src/main/assist'

function fakeClaude(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-title-'))
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return bin
}

function claudeAssist(bin: string, env: NodeJS.ProcessEnv = {}) {
  return koloftAssist({
    setting: () => ({ on: true, backend: 'claude' }),
    enabled: () => true,
    target: async (backend) => (backend === 'claude' ? { binary: bin, env } : null)
  })
}

async function titlePromptFor(task: string, ownerWords: string): Promise<string> {
  let asked = ''
  await titleForTask(
    task,
    async ({ prompt }) => {
      asked = prompt
      return 'title'
    },
    ownerWords
  )
  return asked
}

describe('the title behind koloft session new', () => {
  it('asks Assist once with the picked account, and its reply becomes the name', async () => {
    const bin = fakeClaude('cat >/dev/null\necho "「$CLAUDE_CODE_OAUTH_TOKEN 的标题」"')
    const assist = claudeAssist(bin, { CLAUDE_CODE_OAUTH_TOKEN: 'tok' })
    expect(await titleForTask('修一个问题并发 PR：…', assist)).toBe('tok 的标题')
  })

  it.each([
    ['把侧栏修好', 'Chinese'],
    ['テストをぜんぶ走らせて', 'Japanese'],
    ['日本語で書いてください', 'Japanese'],
    ['전체 테스트를 돌려줘', 'Korean']
  ])(
    'owner words «%s» get the title asked for in %s by name, without the words, so a task that only points to a file is never titled with them',
    async (ownerWords, language) => {
      const prompt = await titlePromptFor('Read /tmp/task-a.md and do it.', ownerWords)
      expect(prompt).toContain(`Write it in ${language}, whatever language the task is in.`)
      expect(prompt).not.toContain(ownerWords)
    }
  )

  it('owner words in letters that do not tell the language are handed to the title model as they are', async () => {
    const prompt = await titlePromptFor('Read /tmp/task-a.md and do it.', 'Lance tous les tests')
    expect(prompt).toContain(
      'Write it in the language of these words of the person, whatever language the task is in: «Lance tous les tests».'
    )
  })

  it('an error claude prints before exiting non-zero is never taken as a name — the task’s first line is', async () => {
    const bin = fakeClaude(
      'cat >/dev/null\necho "Failed to authenticate: OAuth session expired and could not be refreshed"\nexit 1'
    )
    expect(await titleForTask('研究侧栏标题\n背景：…', claudeAssist(bin))).toBe('研究侧栏标题')
  })
})
