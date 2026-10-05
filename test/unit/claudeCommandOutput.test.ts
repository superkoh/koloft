import { describe, it, expect } from 'vitest'
import { commandOutputOf } from '../../src/main/claudeCommandOutput'

const ESC = String.fromCharCode(27)

// CC§2
describe('what a Claude slash command left in the transcript', () => {
  it('a built-in command’s printed text, without the terminal colour codes', () => {
    expect(
      commandOutputOf({
        type: 'system',
        subtype: 'local_command',
        content: `<local-command-stdout>${ESC}[1mContext Usage${ESC}[22m\n⛁ 14%</local-command-stdout>`
      })
    ).toEqual({ kind: 'printed', text: 'Context Usage\n⛁ 14%' })
  })

  it('the same text written as a user record, as /compact and /model do', () => {
    expect(
      commandOutputOf({
        type: 'user',
        message: {
          content: '<local-command-stdout>Set model to Haiku 4.5</local-command-stdout>'
        }
      })
    ).toEqual({ kind: 'printed', text: 'Set model to Haiku 4.5' })
  })

  it('without the line Claude adds for each hook that ran, Koloft’s own PreCompact hook among them', () => {
    expect(
      commandOutputOf({
        type: 'user',
        message: {
          content:
            '<local-command-stdout>Compacted (ctrl+o to see full summary)\nPreCompact ["$HOME/.koloft/hook.sh" "$HOME/.koloft/hook-sessions" "pty-1" compacting] completed successfully</local-command-stdout>'
        }
      })
    ).toEqual({ kind: 'printed', text: 'Compacted (ctrl+o to see full summary)' })
  })

  it('an unknown command’s warning', () => {
    expect(
      commandOutputOf({
        type: 'system',
        subtype: 'informational',
        level: 'warning',
        content: 'Unknown command: /contxt. Did you mean /context?'
      })
    ).toEqual({ kind: 'notice', text: 'Unknown command: /contxt. Did you mean /context?' })
  })

  it('the clean details /context adds for the model', () => {
    expect(
      commandOutputOf({
        type: 'user',
        isMeta: true,
        message: { content: '## Context Usage\n\n**Tokens:** 28.5k / 200k (14%)' }
      })
    ).toEqual({ kind: 'details', text: '## Context Usage\n\n**Tokens:** 28.5k / 200k (14%)' })
  })

  it('nothing for the record that only names the command, an empty output, the caveat, or a prompt', () => {
    for (const record of [
      {
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>'
      },
      {
        type: 'system',
        subtype: 'local_command',
        content: '<local-command-stdout></local-command-stdout>'
      },
      {
        type: 'user',
        isMeta: true,
        message: { content: '<local-command-caveat>Caveat: …</local-command-caveat>' }
      },
      { type: 'user', message: { content: 'please fix the login page' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }
    ])
      expect(commandOutputOf(record)).toBeNull()
  })

  // CC§13
  it('nothing from a message another session sent, though Claude marks it isMeta too', () => {
    expect(
      commandOutputOf({
        type: 'user',
        isMeta: true,
        origin: { kind: 'peer', from: 'unknown' },
        message: { content: 'Another Claude session sent a message:\nhello' }
      })
    ).toBeNull()
  })

  it('nothing from a subagent’s side thread', () => {
    expect(
      commandOutputOf({
        type: 'system',
        subtype: 'informational',
        isSidechain: true,
        content: 'warning'
      })
    ).toBeNull()
  })
})
