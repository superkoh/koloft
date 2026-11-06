import { describe, it, expect } from 'vitest'
import { ClaudeTouchedFiles } from '../../src/main/claudeTouchedFiles'

describe('ClaudeTouchedFiles — the files a Claude Code session read or wrote', () => {
  it('Edit / MultiEdit line deltas and read-never-downgrades-write', () => {
    const touched = new ClaudeTouchedFiles()
    touched.noteToolCall(
      'Edit',
      { file_path: 'a.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree\nfour' },
      '/ws/a.ts',
      1
    )
    touched.noteToolCall('Read', { file_path: 'a.ts' }, '/ws/a.ts', 2)
    expect(touched.files.get('/ws/a.ts')).toMatchObject({ access: 'wrote', added: 4, removed: 2 })
  })
})
