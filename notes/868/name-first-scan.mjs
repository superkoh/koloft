import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
const since = Date.now() - Number(process.argv[3] ?? 30) * 86400_000
const tally = new Map()
const samples = new Map()

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'subagents') walk(p)
    } else if (e.name.endsWith('.jsonl') && fs.statSync(p).mtimeMs > since) scan(p)
  }
}

function scan(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    if (!line.includes('command-name>')) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const c = r.type === 'system' ? r.content : r.message?.content
    if (typeof c !== 'string') continue
    const first = c.startsWith('<command-name>')
      ? 'name-first'
      : c.startsWith('<command-message>')
        ? 'message-first'
        : null
    if (!first) continue
    const name = /<command-name>([^<]*)</.exec(c)?.[1]
    const hasStdout = c.includes('<local-command-stdout>')
    const minor = (r.version ?? '?').split('.').slice(0, 3).join('.')
    const key = `${first} ${r.type}/${r.subtype ?? ''} stdout=${hasStdout} ver=${minor}`
    tally.set(key, (tally.get(key) ?? 0) + 1)
    const names = samples.get(key) ?? new Set()
    if (names.size < 12) names.add(name)
    samples.set(key, names)
  }
}

walk(root)
for (const [k, n] of [...tally].sort()) console.log(n, k, [...samples.get(k)].join(' '))
