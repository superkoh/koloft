import { describe, it, expect } from 'vitest'
import {
  applyDownloadEvent,
  clearFinishedDownloads,
  hasDownloads,
  type DownloadList
} from '../../src/renderer/src/components/downloadList'

/**
 * §04 B9 — the download list's own bookkeeping. It is the durable home for a finished
 * file now that the toast auto-dismisses again, so what matters here is that a record
 * never silently disappears and that a failure is as visible as a success.
 *
 * The list is this run's list: it is never restored, so there is no persistence case.
 */

const empty: DownloadList = { items: [] }

const started = (id: string, name = 'report.csv'): DownloadList =>
  applyDownloadEvent(empty, { id, kind: 'started', name, total: 1000 })

describe('a download appears the moment it starts', () => {
  it('lists it as in-progress, not only once it finishes', () => {
    const list = started('d1')
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ id: 'd1', name: 'report.csv', state: 'progress' })
  })

  it('is what makes the head-band icon appear at all', () => {
    expect(hasDownloads(empty)).toBe(false)
    expect(hasDownloads(started('d1'))).toBe(true)
  })

  it('puts the newest at the top — that is the one being waited on', () => {
    const two = applyDownloadEvent(started('d1', 'first.csv'), {
      id: 'd2',
      kind: 'started',
      name: 'second.csv',
      total: 10
    })
    expect(two.items.map((i) => i.id)).toEqual(['d2', 'd1'])
  })
})

describe('progress', () => {
  it('carries how far it has got', () => {
    const list = applyDownloadEvent(started('d1'), { id: 'd1', kind: 'progress', received: 680 })
    expect(list.items[0]).toMatchObject({ state: 'progress', received: 680, total: 1000 })
  })

  it('never rewinds a record to a smaller number', () => {
    let list = applyDownloadEvent(started('d1'), { id: 'd1', kind: 'progress', received: 680 })
    list = applyDownloadEvent(list, { id: 'd1', kind: 'progress', received: 200 })
    expect(list.items[0].received).toBe(680)
  })

  it('ignores progress for a download it never saw start', () => {
    const list = applyDownloadEvent(empty, { id: 'ghost', kind: 'progress', received: 5 })
    expect(list.items).toHaveLength(0)
  })
})

describe('the three endings each stay visible', () => {
  it('keeps a completed file with the path needed to reveal it', () => {
    const list = applyDownloadEvent(started('d1'), {
      id: 'd1',
      kind: 'done',
      state: 'completed',
      path: '/tmp/dl/report.csv'
    })
    expect(list.items[0]).toMatchObject({ state: 'done', path: '/tmp/dl/report.csv' })
  })

  it('keeps a failed one — a silent failure reads as "my click did nothing"', () => {
    const list = applyDownloadEvent(started('d1'), { id: 'd1', kind: 'done', state: 'interrupted' })
    expect(list.items[0]).toMatchObject({ state: 'failed' })
  })

  it('keeps a cancelled one, and it never becomes completed afterwards', () => {
    let list = applyDownloadEvent(started('d1'), { id: 'd1', kind: 'done', state: 'cancelled' })
    expect(list.items[0]).toMatchObject({ state: 'cancelled' })
    // a late completion event for a cancelled download must not resurrect it
    list = applyDownloadEvent(list, { id: 'd1', kind: 'done', state: 'completed', path: '/tmp/x' })
    expect(list.items[0].state).toBe('cancelled')
  })
})

describe('retry', () => {
  it('reuses the one row rather than growing a second one', () => {
    let list = applyDownloadEvent(started('d1'), { id: 'd1', kind: 'done', state: 'interrupted' })
    list = applyDownloadEvent(list, { id: 'd1', kind: 'retrying' })
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ state: 'progress', received: 0 })
  })

  it('a second retry click while it is already retrying changes nothing', () => {
    let list = applyDownloadEvent(started('d1'), { id: 'd1', kind: 'done', state: 'interrupted' })
    list = applyDownloadEvent(list, { id: 'd1', kind: 'retrying' })
    const once = list
    list = applyDownloadEvent(list, { id: 'd1', kind: 'retrying' })
    expect(list).toEqual(once)
  })
})

describe('clearing', () => {
  it('clears the finished rows and leaves the running one alone', () => {
    let list = started('d1', 'running.bin')
    list = applyDownloadEvent(list, { id: 'd2', kind: 'started', name: 'done.csv', total: 5 })
    list = applyDownloadEvent(list, {
      id: 'd2',
      kind: 'done',
      state: 'completed',
      path: '/tmp/done.csv'
    })
    const cleared = clearFinishedDownloads(list)
    expect(cleared.items.map((i) => i.id)).toEqual(['d1'])
  })

  it('clearing an empty list is not an error', () => {
    expect(clearFinishedDownloads(empty).items).toEqual([])
  })
})
