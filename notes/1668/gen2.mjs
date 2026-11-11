import fs from 'fs'
import path from 'path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const boxes = {
  'write-outside': {
    tool: 'write_file',
    args: { Path: '/home/u/outside.txt', Content: 'written\n' }
  },
  'write-inside': {
    tool: 'write_file',
    args: { Path: '/home/u/ws/inside.txt', Content: 'written\n' }
  },
  'edit-outside': {
    tool: 'edit_file',
    args: { Path: '/home/u/outside-edit.txt', Target: 'old', Replacement: 'new' },
    files: { '/home/u/outside-edit.txt': 'old\n' }
  },
  'edit-inside': {
    tool: 'edit_file',
    args: { Path: '/home/u/ws/inside-edit.txt', Target: 'old', Replacement: 'new' },
    files: { '/home/u/ws/inside-edit.txt': 'old\n' }
  },
  'overwrite-outside': {
    tool: 'write_file',
    args: { Path: '/home/u/outside-over.txt', Content: 'written\n', Overwrite: true },
    files: { '/home/u/outside-over.txt': 'old\n' }
  },
  'overwrite-inside': {
    tool: 'write_file',
    args: { Path: '/home/u/ws/inside-over.txt', Content: 'written\n', Overwrite: true },
    files: { '/home/u/ws/inside-over.txt': 'old\n' }
  },
  'old-create-outside': {
    tool: 'write_to_file',
    args: {
      TargetFile: '/home/u/outside.txt',
      CodeContent: 'written\n',
      Overwrite: false,
      Description: 'd',
      toolSummary: 's',
      toolAction: 'a'
    }
  },
  'old-create-inside': {
    tool: 'write_to_file',
    args: {
      TargetFile: '/home/u/ws/inside.txt',
      CodeContent: 'written\n',
      Overwrite: false,
      Description: 'd',
      toolSummary: 's',
      toolAction: 'a'
    }
  },
  'old-edit-outside': {
    tool: 'replace_file_content',
    args: {
      TargetFile: '/home/u/outside-edit.txt',
      TargetContent: 'old',
      ReplacementContent: 'new',
      StartLine: 1,
      EndLine: 1,
      AllowMultiple: false,
      Instruction: 'i',
      Description: 'd',
      toolSummary: 's',
      toolAction: 'a'
    },
    files: { '/home/u/outside-edit.txt': 'old\n' }
  },
  'old-read-outside': {
    tool: 'view_file',
    args: { AbsolutePath: '/home/u/outside-read.txt', toolSummary: 's', toolAction: 'a' },
    files: { '/home/u/outside-read.txt': 'secret\n' }
  },
  'read-outside': {
    tool: 'read_file',
    args: { Path: '/home/u/outside-read.txt' },
    files: { '/home/u/outside-read.txt': 'secret\n' }
  },
  command: {
    tool: 'run_command',
    args: { CommandLine: 'touch /home/u/ws/ran.txt', WaitMsBeforeAsync: 2000, toolSummary: 'touch' }
  }
}
const DOWN = '\u001b[B'
const answers = {
  esc: { key: '\u001b' },
  'down x5 enter': { key: `${DOWN}${DOWN}${DOWN}${DOWN}${DOWN}\r` },
  'key 3': { key: '3' },
  'key 2': { key: '2' },
  'key 4': { key: '4' },
  'api no': { api: false }
}
const versions = {
  142: '/home/u/agy142/antigravity',
  153: '/home/u/agy153/antigravity',
  155: '/home/u/agy155/antigravity'
}
const pick = JSON.parse(process.argv[2])
const cases = []
for (const [v, b, a] of pick)
  cases.push({ label: `${v} ${b} ${a}`, bin: versions[v], ...boxes[b], ...answers[a] })
fs.writeFileSync(path.join(HERE, process.argv[3]), JSON.stringify(cases, null, 1))
console.log(cases.length)
