import { describe, it, expect } from 'vitest'
import { toDiscordMarkdown } from '../../src/main/discord/markdown'

describe('markdown Discord shows as plain text is rewritten into what it does show', () => {
  it('a table of any width, since no code block lines up on a phone, becomes one block per row: the first cell in bold, then each other cell on its own quoted line under its header, blocks a blank line apart, empty cells left out', () => {
    const table = [
      '| File | Change | State |',
      '|------|:------:|-------|',
      '| **src/main/discord/relay.ts** | +12 −3 | **done** |',
      '| test/unit/discordSplit.test.ts |  | ⏳ |'
    ].join('\n')
    expect(toDiscordMarkdown(table)).toBe(
      [
        '**src/main/discord/relay.ts**',
        '> Change: +12 −3',
        '> State: **done**',
        '',
        '**test/unit/discordSplit.test.ts**',
        '> State: ⏳'
      ].join('\n')
    )
  })

  it('a Chinese header takes a full-width colon', () => {
    expect(toDiscordMarkdown('| 会话 | 工作区 |\n|---|---|\n| fix-login | koloft |')).toBe(
      '**fix-login**\n> 工作区：koloft'
    )
  })

  it('headings below ### turn bold, a rule goes, task boxes become ☐ and ☑, and an image becomes its link', () => {
    expect(
      toDiscordMarkdown(
        [
          '#### Step 4',
          '---',
          '- [ ] write it',
          '  - [x] test it',
          '![shot](https://x/a.png)'
        ].join('\n')
      )
    ).toBe(
      ['**Step 4**', '', '- ☐ write it', '  - ☑ test it', '[shot](https://x/a.png)'].join('\n')
    )
  })

  it('leaves what Discord already shows, and everything inside a code block, exactly as written', () => {
    const kept = [
      '# Title',
      '### Small title',
      '-# subtext',
      '- item',
      '  - nested',
      '> quote',
      '```md',
      '| a | b |',
      '|---|---|',
      '#### not a heading here',
      '---',
      '```',
      'line 1',
      '',
      'line 2'
    ].join('\n')
    expect(toDiscordMarkdown(kept)).toBe(kept)
  })
})
