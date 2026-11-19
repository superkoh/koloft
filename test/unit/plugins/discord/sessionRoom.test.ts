import { describe, expect, it } from 'vitest'
import { roomNote } from '../../../../src/plugins/discord/main/sessionRoom'

describe('a session’s room on Discord', () => {
  it('the butler’s session list ends a row with a room with its link, and says when the owner put it down at the Mac', () => {
    expect(roomNote({ threadId: '71' })).toBe('room on Discord: <#71>')
    expect(roomNote({ threadId: '71', putDown: true })).toBe(
      'room on Discord: <#71> (put down: the owner took it back at the Mac)'
    )
  })
})
