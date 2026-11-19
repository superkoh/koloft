import { describe, expect, it } from 'vitest'
import { todoNotes } from '../../../../src/plugins/todo/main/notes'

describe('Todo keeps its own notes in its todoNotes setting', () => {
  it('saving a note empty takes it away and keeps the others', () => {
    let saved: Record<string, string> = { koloft: 'Issues assigned to me.', site: 'Open PRs.' }
    const notes = todoNotes({
      load: () => ({ todoNotes: saved }),
      commit: ({ todoNotes }) => (saved = todoNotes)
    })
    notes.saveNote('koloft', '')
    expect(notes.notes()).toEqual({ site: 'Open PRs.' })
  })
})
