import { describe, expect, it } from 'vitest'
import { hookOverrides, trustedInPlace } from '../../src/main/codexLaunchConfig'

// CODEX§27
describe("Koloft's Codex hooks on an app-server's command line", () => {
  const look = { event: 'PreToolUse', matcher: 'Bash', command: 'look' }
  const hold = { event: 'PreToolUse', matcher: 'Bash', command: 'hold' }
  const tool = { event: 'PostToolUse', command: 'tool' }

  it('two hooks of one event go in one value, as two groups in order', () => {
    expect(hookOverrides([look, hold, tool])).toEqual([
      'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="look"}]},{matcher="Bash",hooks=[{type="command",command="hold"}]}]',
      'hooks.PostToolUse=[{hooks=[{type="command",command="tool"}]}]'
    ])
  })

  it('a hook Codex does not trust leaves out the later hooks of its event too, so none of them moves onto the trust key of the group before it; other events keep theirs', () => {
    expect(trustedInPlace([look, hold, tool], new Set(['hold', 'tool']))).toEqual([tool])
    expect(trustedInPlace([look, hold, tool], new Set(['look', 'tool']))).toEqual([look, tool])
  })
})
