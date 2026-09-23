import { describe, it, expect } from 'vitest'
import {
  HISTORY_CAP,
  clearHistory,
  loadHistory,
  match,
  remember,
  saveHistory
} from '../../src/renderer/src/browserHistory'
import { SEARCH_URL } from '../../src/shared/browserRoute'
import { installLocalStorage } from './localStorageStub'

installLocalStorage()

describe('remember', () => {
  it('moves a revisited page to the front instead of adding a second entry', () => {
    const list = remember(remember(remember([], 'https://a.com'), 'https://b.com'), 'https://a.com')
    expect(list.map((e) => e.url)).toEqual(['https://a.com', 'https://b.com'])
  })

  it('evicts the oldest entry once the cap is full', () => {
    let list = remember([], 'https://old.com')
    for (let i = 0; i < HISTORY_CAP; i++) list = remember(list, `https://p${i}.com`)
    expect(list).toHaveLength(HISTORY_CAP)
    expect(list.some((e) => e.url === 'https://old.com')).toBe(false)
  })

  it('treats two fragments of one page as one entry', () => {
    const list = remember(remember([], 'https://a.com/p#a'), 'https://a.com/p#b')
    expect(list.map((e) => e.url)).toEqual(['https://a.com/p'])
  })

  it('records neither about:blank nor an address-bar search', () => {
    expect(remember([], 'about:blank')).toEqual([])
    expect(remember([], `${SEARCH_URL}zeb`)).toEqual([])
  })

  it('keeps the known title when a later visit brings none', () => {
    const list = remember(remember([], 'https://a.com', 'Zebra'), 'https://a.com')
    expect(list[0].title).toBe('Zebra')
  })
})

describe('match', () => {
  const list = [
    { url: 'https://www.github.com/x', title: 'Code host' },
    { url: 'http://localhost:3000/z', title: 'Zebra' }
  ]

  it('ignores scheme, www. and case on both sides', () => {
    expect(match(list, 'HTTPS://GitHub').map((e) => e.url)).toEqual(['https://www.github.com/x'])
  })

  it('finds a page by its title', () => {
    expect(match(list, 'zeb').map((e) => e.url)).toEqual(['http://localhost:3000/z'])
  })

  it('suggests nothing for an empty query', () => {
    expect(match(list, '  ')).toEqual([])
  })
})

describe('storage', () => {
  it('round-trips, and clearing leaves nothing behind', () => {
    saveHistory([{ url: 'https://a.com', title: 'A' }])
    expect(loadHistory()).toEqual([{ url: 'https://a.com', title: 'A' }])
    clearHistory()
    expect(loadHistory()).toEqual([])
  })
})
