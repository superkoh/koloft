import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const rows = fs
  .readFileSync(path.join(here, 'results.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (v.length === 0) return '-'
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2)
}
const mean = (xs) => {
  const v = xs.filter((x) => typeof x === 'number')
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : '-'
}

const lines = [
  '| agent | prompt | calls | failed | median wall ms | median model ms | mean reply chars | mean output tokens |',
  '|---|---|---|---|---|---|---|---|'
]
for (const backend of [...new Set(rows.map((r) => r.backend))]) {
  for (const variant of ['withWhy', 'withoutWhy']) {
    const rs = rows.filter((r) => r.backend === backend && r.variant === variant)
    const ok = rs.filter((r) => r.reply)
    lines.push(
      `| ${backend} | ${variant} | ${rs.length} | ${rs.length - ok.length} | ${median(ok.map((r) => r.ms))} | ${median(ok.map((r) => r.apiMs))} | ${mean(ok.map((r) => r.replyChars))} | ${mean(ok.map((r) => r.outputTokens))} |`
    )
  }
}

lines.push('', '| agent | message | routes with why | routes without why |', '|---|---|---|---|')
for (const backend of [...new Set(rows.map((r) => r.backend))]) {
  for (const message of [...new Set(rows.map((r) => r.message))]) {
    const of = (variant) =>
      rows
        .filter((r) => r.backend === backend && r.message === message && r.variant === variant)
        .map((r) => r.route)
        .join(', ')
    lines.push(`| ${backend} | ${message} | ${of('withWhy')} | ${of('withoutWhy')} |`)
  }
}
console.log(lines.join('\n'))
