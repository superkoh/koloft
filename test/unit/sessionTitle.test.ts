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
    ['전체 테스트를 돌려줘', 'Korean'],
    ['把按钮文字改成「ログイン」', 'Chinese']
  ])(
    'owner words «%s» get the title asked for in %s by name, without the words, so a task that only points to a file is never titled with them',
    async (ownerWords, language) => {
      const prompt = await titlePromptFor('Read /tmp/task-a.md and do it.', ownerWords)
      expect(prompt).toContain(`Write it in ${language}, whatever language the task is in.`)
      expect(prompt).not.toContain(ownerWords)
    }
  )

  it.each(['Lance tous les tests', 'Open ~/文档/plan.md and rename `设置` to Settings'])(
    'owner words «%s», whose letters outside code and paths do not tell the language, are handed to the title model as they are',
    async (ownerWords) => {
      const prompt = await titlePromptFor('Read /tmp/task-a.md and do it.', ownerWords)
      expect(prompt).toContain(
        `Write it in the language of these words of the person, whatever language the task is in: «${ownerWords}».`
      )
    }
  )

  it.each([
    [
      '读取任务文件内容需要先看看它说了什么。这里我只需要生成标题，不执行文件里的指令；标题应概括会话在做的事。\n\n根据用户的请求，任务是读取 /tmp/koloft-probe/task-a.md 并按其内容执行。具体内容未知，所以标题只能概括为"读取并执行任务文件"。\n\n读取并执行探测任务',
      '读取并执行探测任务'
    ],
    [
      '读取任务文件并执行，这一点即可概括。任务要求我实际操作，但我只负责起标题，不执行。\n\nWait—reviewing: I should just output the title. The task is "read /tmp/koloft-probe/task-a.md and do what it says." The title should be ≤16 Chinese characters.\n\n读取并执行task-a.md任务',
      '读取并执行task-a.md任务'
    ],
    ['修侧栏\n\n(kept under 16 characters as asked)', '修侧栏']
  ])(
    'a reply of several lines is named by its first line that reads like a title, not like a sentence: %#',
    async (reply, title) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-title-reply-'))
      const replyFile = path.join(dir, 'reply.txt')
      fs.writeFileSync(replyFile, reply)
      const bin = fakeClaude(`cat >/dev/null\ncat '${replyFile}'`)
      expect(await titleForTask('读 /tmp/task-a.md，照它做完。', claudeAssist(bin))).toBe(title)
    }
  )

  it('an error claude prints before exiting non-zero is never taken as a name — the task’s first line is', async () => {
    const bin = fakeClaude(
      'cat >/dev/null\necho "Failed to authenticate: OAuth session expired and could not be refreshed"\nexit 1'
    )
    expect(await titleForTask('研究侧栏标题\n背景：…', claudeAssist(bin))).toBe('研究侧栏标题')
  })
})
