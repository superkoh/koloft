import { describe, it, expect } from 'vitest'
import { ClaudeDialogWatch } from '../../src/main/claudeDialogWatch'
import { PROGRAM_STATUS_REPLY } from '../../src/main/programStatus'

const QUERY = '\x1b]7501;?\x07'
const frame = (body: string): string => `\x1b]7501;${body}:app=claude-code\x07`

function watch(watched: string[]) {
  const replies: [string, string][] = []
  const closed: string[] = []
  const w = new ClaudeDialogWatch({
    watches: (tabId) => watched.includes(tabId),
    reply: (tabId, text) => void replies.push([tabId, text]),
    closed: (tabId) => void closed.push(tabId)
  })
  return { w, replies, closed }
}

describe('ClaudeDialogWatch — a local Claude tab tells Koloft when its dialog closes', () => {
  it('answers the status query, then reports a dialog closed once when the state leaves blocked', () => {
    const { w, replies, closed } = watch(['t1'])
    expect(w.showsDialogsClosing('t1')).toBe(false)
    w.data('t1', `banner${QUERY}`)
    expect(replies).toEqual([['t1', PROGRAM_STATUS_REPLY]])
    expect(w.showsDialogsClosing('t1')).toBe(true)

    w.data('t1', frame('state=working'))
    w.data('t1', frame('state=blocked:kind=permission').slice(0, 12))
    w.data('t1', frame('state=blocked:kind=permission').slice(12))
    expect(closed).toEqual([])
    w.data('t1', frame('state=working') + frame('state=working'))
    expect(closed).toEqual(['t1'])
  })

  it('a tab it does not watch — remote, or another agent — gets no reply and reports nothing', () => {
    const { w, replies, closed } = watch([])
    w.data('t2', QUERY + frame('state=blocked:kind=permission') + frame('state=working'))
    expect(replies).toEqual([])
    expect(closed).toEqual([])
    expect(w.showsDialogsClosing('t2')).toBe(false)
  })
})
