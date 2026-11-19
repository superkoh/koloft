type TodoNotes = Record<string, string>

export interface TodoSettings {
  load(): { todoNotes: TodoNotes }
  commit(patch: { todoNotes: TodoNotes }): unknown
}

export function todoNotes(settings: TodoSettings): {
  notes(): TodoNotes
  saveNote(key: string, text: string): void
} {
  return {
    notes: () => settings.load().todoNotes,
    saveNote: (key, text) => {
      const todoNotes = { ...settings.load().todoNotes, [key]: text }
      if (!text) delete todoNotes[key]
      settings.commit({ todoNotes })
    }
  }
}
