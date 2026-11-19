import { describe, expect, it } from 'vitest'
import { todoNotes } from '../../../../src/plugins/todo/main/notes'

function saved(start: Record<string, string>) {
  let todoNotesNow = start
  const notes = todoNotes({
    load: () => ({ todoNotes: todoNotesNow }),
    commit: ({ todoNotes }) => (todoNotesNow = todoNotes)
  })
  return { notes, now: () => todoNotesNow }
}

describe('Todo keeps its own notes in its todoNotes setting', () => {
  it('a note is saved beside the others, and saving it empty takes it away', () => {
    const { notes, now } = saved({ koloft: 'Issues assigned to me.' })
    notes.saveNote('site', 'Open PRs.')
    expect(now()).toEqual({ koloft: 'Issues assigned to me.', site: 'Open PRs.' })
    notes.saveNote('koloft', '')
    expect(notes.notes()).toEqual({ site: 'Open PRs.' })
  })
})
