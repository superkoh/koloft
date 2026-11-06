import { describe, it, expect } from 'vitest'
import { ClaudeDialogWatch } from '../../src/main/claudeDialogWatch'
import { PROGRAM_STATUS_REPLY } from '../../src/main/programStatus'

const QUERY = '\x1b]7501;?\x07'
const frame = (body: string): string => `\x1b]7501;${body}:app=claude-code\x07`
const blocked = (what: string): string =>
  frame(`state=blocked:kind=permission:msg=${Buffer.from(what).toString('base64')}`)

function watch() {
  const processes = new Map<string, object>([['t1', {}]])
  const replies: [string, string][] = []
  const closed: string[] = []
  const w = new ClaudeDialogWatch({
    watchedProcess: (tabId) => processes.get(tabId),
    reply: (tabId, text) => void replies.push([tabId, text]),
    closed: (tabId) => void closed.push(tabId)
  })
  return { w, processes, replies, closed }
}

describe('ClaudeDialogWatch — a local Claude tab tells Koloft when its dialog closes', () => {
  it('answers the status query, counts on it once the first state comes, and reports a dialog closed once when the state leaves blocked', () => {
    const { w, replies, closed } = watch()
    w.data('t1', `banner${QUERY}`)
    expect(replies).toEqual([['t1', PROGRAM_STATUS_REPLY]])
    expect(w.showsDialogsClosing('t1')).toBe(false)
    w.data('t1', frame('state=working'))
    expect(w.showsDialogsClosing('t1')).toBe(true)

    w.data('t1', blocked('approve Bash: ls').slice(0, 12))
    w.data('t1', blocked('approve Bash: ls').slice(12))
    expect(closed).toEqual([])
    w.data('t1', frame('state=working') + frame('state=working'))
    expect(closed).toEqual(['t1'])
  })

  it('a dialog followed straight by another counts as closed; the program ending does not', () => {
    const { w, closed } = watch()
    w.data('t1', QUERY + blocked('approve Bash: ls') + blocked('approve Bash: ls'))
    expect(closed).toEqual([])
    w.data('t1', blocked('approve Bash: make'))
    expect(closed).toEqual(['t1'])
    w.data('t1', frame('state=clear'))
    expect(closed).toEqual(['t1'])
  })

  it('a tab it does not watch — remote, or another agent — gets no reply and reports nothing', () => {
    const { w, replies, closed } = watch()
    w.data('t2', QUERY + blocked('approve Bash: ls') + frame('state=working'))
    expect(replies).toEqual([])
    expect(closed).toEqual([])
    expect(w.showsDialogsClosing('t2')).toBe(false)
  })

  it('a new program in the same tab starts over: an old dialog does not close in it, and it must report again', () => {
    const { w, processes, closed } = watch()
    w.data('t1', QUERY + frame('state=working') + blocked('approve Bash: ls'))
    processes.set('t1', {})
    expect(w.showsDialogsClosing('t1')).toBe(false)
    w.data('t1', frame('state=working'))
    expect(closed).toEqual([])
  })
})
