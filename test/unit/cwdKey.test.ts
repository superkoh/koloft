import { describe, it, expect, afterEach } from 'vitest'
import { NOTES_TAB, notesOwner } from '@shared/cwdKey'
import { allEditTabs, beginEdit, endEdit } from '../../src/renderer/src/editRegistry'

const WS_WITH_SPACES = '/Users/me/My Projects/koloft app'

afterEach(() => endEdit(notesOwner(WS_WITH_SPACES), NOTES_TAB))

describe('notesOwner', () => {
  it('keys a workspace whose path has spaces as exactly one note buffer, since the edit registry splits owner from tab on a space', () => {
    const owner = notesOwner(WS_WITH_SPACES)
    beginEdit(owner, NOTES_TAB, {
      path: WS_WITH_SPACES + '/.notes',
      text: 'todo',
      eol: 'lf',
      stamp: { mtimeMs: 1, size: 4 },
      readOnly: null
    })
    expect(allEditTabs().filter((t) => t.path === WS_WITH_SPACES + '/.notes')).toEqual([
      { ownerTabId: owner, tabId: NOTES_TAB, path: WS_WITH_SPACES + '/.notes' }
    ])
  })
})
