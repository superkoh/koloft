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
  const shown: boolean[] = []
  const w = new ClaudeDialogWatch({
    watchedProcess: (tabId) => processes.get(tabId),
    reply: (tabId, text) => void replies.push([tabId, text]),
    dialogShown: (_tabId, onScreen) => void shown.push(onScreen),
    closed: (tabId, stateAfter) => {
      closed.push(tabId)
      statesAfter.push(stateAfter)
    }
  })
  return { w, processes, replies, closed, statesAfter, shown }
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

  it('tells when a permission or question dialog comes on screen and leaves it, and what claude went on to: working once answered, idle once turned down', () => {
    const { w, shown, statesAfter } = watch()
    w.data('t1', QUERY + frame('state=working'))
    w.data('t1', blocked('approve Bash: ls') + blocked('approve Bash: ls'))
    expect(shown).toEqual([true])
    w.data('t1', frame('state=working'))
    w.data('t1', blocked('approve Bash: make') + frame('state=idle'))
    w.data('t1', frame('state=blocked:kind=question:msg=YW5zd2Vy'))
    w.data('t1', frame('state=working'))
    expect(shown).toEqual([true, false, true, false, true, false])
    expect(statesAfter).toEqual(['working', 'idle', 'working'])
    w.data('t1', frame('state=blocked:kind=auth') + frame('state=blocked:kind=permission'))
    expect(shown).toEqual([true, false, true, false, true, false, true])
    w.data('t1', frame('state=error'))
    expect(shown.at(-1)).toBe(false)
  })

  it('a dialog left on screen by a claude that is gone is taken off: on exit, and when a new program starts in the tab', () => {
    const { w, processes, shown } = watch()
    w.data('t1', QUERY + blocked('approve Bash: ls'))
    processes.set('t1', {})
    w.data('t1', frame('state=idle'))
    expect(shown).toEqual([true, false])
    w.data('t1', QUERY + blocked('approve Bash: ls') + frame('state=clear'))
    expect(shown).toEqual([true, false, true, false])
    w.data('t1', blocked('approve Bash: ls'))
    w.forget('t1')
    expect(shown).toEqual([true, false, true, false, true, false])
  })

  it('a dialog counts as just closed only for as long as a hook line fired before the answer may still land, and a login block is no dialog', () => {
    vi.useFakeTimers()
    try {
      const { w } = watch()
      w.data('t1', QUERY + frame('state=blocked:kind=auth') + frame('state=working'))
      expect(w.justClosedADialog('t1')).toBe(false)
      w.data('t1', blocked('approve Bash: ls'))
      expect(w.justClosedADialog('t1')).toBe(false)
      w.data('t1', frame('state=working'))
      expect(w.justClosedADialog('t1')).toBe(true)
      vi.advanceTimersByTime(A_HOOK_LINE_FIRED_BEFORE_THE_ANSWER_LANDS_WITHIN_MS)
      expect(w.justClosedADialog('t1')).toBe(false)
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
