import { describe, expect, it } from 'vitest'
import { codexShowsAPanel } from '../../src/main/inputBox'

const FOOTER = ['', '  GPT-6.1-Sol default · ~/work', '  ? for shortcuts', '', '']
const COMPOSER = ['› Ask Codex to do anything', ...FOOTER]
const RULE = '─'.repeat(100)

// CODEX§21
describe('Codex shows a panel: the closing key a menu, list or pager names under its last › row', () => {
  it('never answers "no panel", since a command left unsent in the composer looks like an empty one, and a reply above the composer that names those keys is not a panel', () => {
    expect(codexShowsAPanel(['  >_ OpenAI Codex (v0.166.0)', '', ...COMPOSER])).toBeUndefined()
    expect(
      codexShowsAPanel([
        '/status',
        '  Model:               GPT-6.1-Sol (reasoning low, summaries auto)',
        '  Limits:              data not available yet',
        '',
        ...COMPOSER
      ])
    ).toBeUndefined()
    expect(
      codexShowsAPanel(['• The pager says q close, and the picker says esc back.', '', ...COMPOSER])
    ).toBeUndefined()
  })

  it('sees the pickers /model, /permissions and /review and the /keymap list, whose highlighted row carries the › mark', () => {
    expect(
      codexShowsAPanel([
        '  Select Model and Effort',
        '',
        '› 1. GPT-6.1-Sol (current)  Latest workhorse model for coding and everyday work.',
        '  2. GPT-6-Astra            Frontier intelligence for the most demanding work.',
        '↓',
        '  enter select · esc back'
      ])
    ).toBe(true)
    expect(
      codexShowsAPanel([
        '› Global       - Open Agents                unbound',
        '  Composer       Submit                     enter',
        '↓',
        '  left/right group · enter edit shortcut · * custom · - unbound · esc close'
      ])
    ).toBe(true)
  })

  it('sees the full-screen /resume list and the /diff pager, which only q closes', () => {
    expect(
      codexShowsAPanel([
        ' Resume a previous session',
        '  No sessions yet',
        `${RULE} 0 / 0 · 100% ─`,
        ' enter resume   esc exit   ⌃c exit   tab focus sort/filter   ←/→ change option',
        ' ⌃o comfortable view   ⌃t transcript   ⌃e expand   ↑/↓ browse',
        ''
      ])
    ).toBe(true)
    expect(
      codexShowsAPanel([
        '/ D I F F / / / / /',
        '+two',
        '~',
        `${RULE} 100% ─`,
        ' ↑/↓ to scroll · pgup/pgdn to page · home/end to jump',
        ' q close',
        ''
      ])
    ).toBe(true)
  })
})
