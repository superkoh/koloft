import { describe, it, expect } from 'vitest'
import { TABLE_FITS_A_PHONE_COLUMNS, toDiscordMarkdown } from '../../src/main/discord/markdown'

describe('markdown Discord shows as plain text is rewritten into what it does show', () => {
  it('a table that fits a phone becomes a code block with its columns lined up, wide characters counted twice, and inline marks dropped', () => {
    const table = [
      '| 文件 | 改动 |',
      '|---|:---:|',
      '| **relay.ts** | `+12` |',
      '| [split](http://x) | +40 |'
    ].join('\n')
    expect(toDiscordMarkdown(table)).toBe(
      ['```', '文件      改动', '────────  ────', 'relay.ts  +12', 'split     +40', '```'].join(
        '\n'
      )
    )
  })

  it(`a table wider than ${TABLE_FITS_A_PHONE_COLUMNS} columns becomes one list item per row, the first cell in bold and the rest as "header: value"`, () => {
    const table = [
      '| File | Change | State |',
      '|------|--------|-------|',
      '| src/main/discord/relay.ts | +12 −3 | **done** |',
      '| test/unit/discordSplit.test.ts |  | ⏳ |'
    ].join('\n')
    expect(toDiscordMarkdown(table)).toBe(
      [
        '- **src/main/discord/relay.ts**',
        '  Change: +12 −3 · State: **done**',
        '- **test/unit/discordSplit.test.ts**',
        '  State: ⏳'
      ].join('\n')
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
