export interface RowsInMemory {
  pinned(): string[]
  rows(workspacePath: string): unknown[]
  members(): Iterable<string>
  reread(): void
}

export function rereadWhenRowsInMemoryChange(d: RowsInMemory): () => void {
  let lastKey = ''
  return () => {
    const rows = d.pinned().map((workspacePath) => d.rows(workspacePath))
    const members = [...d.members()].sort()
    const key = JSON.stringify([rows, members])
    if (key === lastKey) return
    lastKey = key
    d.reread()
  }
}
