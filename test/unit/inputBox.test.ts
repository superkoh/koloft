import { describe, expect, it } from 'vitest'
import { codexShowsAPanel } from '../../src/main/inputBox'

const FOOTER = ['', '  GPT-6.1-Sol default · ~/work', '  ? for shortcuts', '', '']
const COMPOSER = ['› Ask Codex to do anything', ...FOOTER]
const RULE = '─'.repeat(100)

// CODEX§21
describe('Codex shows a panel: what its TUI draws at the bottom of the screen', () => {
  it('sees no panel at the idle composer, after /status or /mcp drew their answer above it, or after an Esc at the composer', () => {
    expect(codexShowsAPanel(['  >_ OpenAI Codex (v0.166.0)', '', ...COMPOSER])).toBe(false)
    expect(
      codexShowsAPanel([
        '/status',
        '  Model:               GPT-6.1-Sol (reasoning low, summaries auto)',
        '  Limits:              data not available yet',
        '',
        ...COMPOSER
      ])
    ).toBe(false)
    expect(
      codexShowsAPanel(['/mcp', '🔌  MCP Tools', '  • docs: connected (3 tools)', '', ...COMPOSER])
    ).toBe(false)
    expect(codexShowsAPanel(['• No previous message to edit.', '', ...COMPOSER])).toBe(false)
    expect(
      codexShowsAPanel(['› Ask Codex to do anything', '', '  esc again to edit previous message'])
    ).toBe(false)
  })

  it('sees the pickers /model, /permissions and /review, the /keymap list and the /mention menu over the composer', () => {
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
    expect(
      codexShowsAPanel([
        '  Mentions',
        '› Image Gen        Generate or edit images for websites, games, and more   Skill',
        '  OpenAI Docs      OpenAI and Codex docs for models, skills, tasks, and setup   Skill',
        '',
        '',
        '',
        '',
        '  enter/tab insert · esc close · ↑/↓ select · ←/→ filter',
        '',
        '› @',
        '',
        '  GPT-6.1-Sol default · ~/work',
        ''
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
