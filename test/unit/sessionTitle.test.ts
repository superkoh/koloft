import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { nameForTask } from '../../src/main/sessionTitle'
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
    claude: async () => ({ binary: bin, env }),
    codex: async () => null
  })
}

describe('the title behind koloft session new', () => {
  it('asks Assist once with the picked account, and its reply becomes the name', async () => {
    const bin = fakeClaude('cat >/dev/null\necho "「$CLAUDE_CODE_OAUTH_TOKEN 的标题」"')
    const assist = claudeAssist(bin, { CLAUDE_CODE_OAUTH_TOKEN: 'tok' })
    expect(await nameForTask('修一个问题并发 PR：…', assist, new Set())).toBe('tok 的标题')
  })

  it('an error claude prints before exiting non-zero is never taken as a name — the task’s first line is', async () => {
    const bin = fakeClaude(
      'cat >/dev/null\necho "Failed to authenticate: OAuth session expired and could not be refreshed"\nexit 1'
    )
    expect(await nameForTask('研究侧栏标题\n背景：…', claudeAssist(bin), new Set())).toBe(
      '研究侧栏标题'
    )
  })
})
