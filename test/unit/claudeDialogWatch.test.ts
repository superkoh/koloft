import { describe, it, expect, vi } from 'vitest'
import {
  A_HOOK_LINE_FIRED_BEFORE_THE_ANSWER_LANDS_WITHIN_MS,
  ClaudeDialogWatch
} from '../../src/main/claudeDialogWatch'
import { PROGRAM_STATUS_REPLY } from '../../src/main/programStatus'

const QUERY = '\x1b]7501;?\x07'
const frame = (body: string): string => `\x1b]7501;${body}:app=claude-code\x07`
const blocked = (what: string): string =>
  frame(`state=blocked:kind=permission:msg=${Buffer.from(what).toString('base64')}`)

function watch() {
  const processes = new Map<string, object>([['t1', {}]])
  const replies: [string, string][] = []
  const closed: string[] = []
  const statesAfter: string[] = []
  const drawn: string[] = []
  const w = new ClaudeDialogWatch({
    watchedProcess: (tabId) => processes.get(tabId),
    reply: (tabId, text) => void replies.push([tabId, text]),
    dialogDrawn: (tabId) => void drawn.push(tabId),
    closed: (tabId, stateAfter) => {
      closed.push(tabId)
      statesAfter.push(stateAfter)
    }
  })
  return { w, processes, replies, closed, statesAfter, drawn }
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

  it('tells each permission or question dialog once as it draws, and what claude went on to: working once answered, idle once turned down', () => {
    const { w, drawn, statesAfter } = watch()
    w.data('t1', QUERY + frame('state=working'))
    w.data('t1', blocked('approve Bash: ls') + blocked('approve Bash: ls'))
    expect(drawn).toEqual(['t1'])
    expect(w.dialog('t1')).toBe('on-screen')
    w.data('t1', frame('state=working'))
    w.data('t1', blocked('approve Bash: make') + frame('state=idle'))
    w.data('t1', frame('state=blocked:kind=question:msg=YW5zd2Vy'))
    expect(drawn).toEqual(['t1', 't1', 't1'])
    expect(w.dialog('t1')).toBe('on-screen')
    w.data('t1', frame('state=working'))
    expect(statesAfter).toEqual(['working', 'idle', 'working'])
    w.data('t1', frame('state=blocked:kind=auth'))
    expect(drawn).toEqual(['t1', 't1', 't1'])
    expect(w.dialog('t1')).not.toBe('on-screen')
  })

  it('a dialog counts as just closed only for as long as a hook line fired before the answer may still land', () => {
    vi.useFakeTimers()
    try {
      const { w } = watch()
      w.data('t1', QUERY + frame('state=working'))
      expect(w.dialog('t1')).toBeUndefined()
      w.data('t1', blocked('approve Bash: ls') + frame('state=working'))
      expect(w.dialog('t1')).toBe('just-closed')
      vi.advanceTimersByTime(A_HOOK_LINE_FIRED_BEFORE_THE_ANSWER_LANDS_WITHIN_MS)
      expect(w.dialog('t1')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
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
