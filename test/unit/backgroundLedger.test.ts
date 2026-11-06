import { describe, it, expect } from 'vitest'
import { BackgroundLedger } from '../../src/main/backgroundLedger'

const monitorEvent = (id: string): string =>
  `<task-notification>\n<task-id>${id}</task-id>\n<summary>Monitor event: "service errors"</summary>\n<event>15:05 ERROR</event>\n</task-notification>`
const finished = (id: string): string =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<status>completed</status>\n</task-notification>`

// CC§8
describe('BackgroundLedger — a Monitor known only by its event notices', () => {
  it('is a monitor from its first event, labelled by its description', () => {
    const ledger = new BackgroundLedger()
    expect(ledger.noteNotification(monitorEvent('mon_a'))).toEqual(new Set())
    expect(ledger.isMonitor('mon_a')).toBe(true)
    expect(ledger.labelOf('mon_a')).toBe('service errors')
  })

  it('stays a monitor when another task finishes in the same message, and only that task is gone', () => {
    const ledger = new BackgroundLedger()
    const gone = ledger.noteNotification(monitorEvent('mon_a') + '\n' + finished('shell_b'))
    expect(gone).toEqual(new Set(['shell_b']))
    expect(ledger.isMonitor('mon_a')).toBe(true)
    expect(ledger.isMonitor('shell_b')).toBe(false)
  })
})
