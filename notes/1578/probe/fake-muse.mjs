import fs from 'fs'
import http from 'http'

const PORT = Number(process.argv[2] ?? 8787)
const logFile = process.argv[3]
const LINK_PORT = 47811
const CATALOG = {
  object: 'list',
  data: [{ id: 'fake-model', object: 'model', owned_by: 'koloft' }]
}
const LINES = 160
const LINES_PER_DELTA = 4
const DELTA_GAP_MS = 60
let n = 0

const log = (obj) => logFile && fs.appendFileSync(logFile, JSON.stringify(obj) + '\n')

function lines() {
  const out = ['Here is the long answer.', '']
  for (let i = 1; i <= LINES; i++) {
    out.push(
      `${i}. Line ${i}: see [doc ${i}](http://127.0.0.1:${LINK_PORT}/link-${i}) and also http://127.0.0.1:${LINK_PORT}/bare-${i} for part ${i}.`
    )
  }
  out.push('', 'END-OF-REPLY')
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', async () => {
      log({ url: req.url, method: req.method })
      if (req.url.includes('/muse-code/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(CATALOG))
      }
      if (req.url.includes('/muse-code/config')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{}')
      }
      if (!req.url.endsWith('/responses')) {
        res.writeHead(404).end()
        return
      }
      const role = req.headers['x-tbh-agent-role'] || ''
      let seq = 0
      const send = (type, data) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`
        )
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const id = `resp_${++n}`
      const base = {
        id,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: 'fake-model'
      }
      send('response.created', { response: { ...base, status: 'in_progress', output: [] } })
      const all = role === 'judge' ? ['ok'] : lines()
      const text = all.join('\n')
      const msgId = `msg_${n}`
      send('response.output_item.added', {
        output_index: 0,
        item: { type: 'message', role: 'assistant', id: msgId, status: 'in_progress', content: [] }
      })
      send('response.content_part.added', {
        output_index: 0,
        item_id: msgId,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      })
      for (let i = 0; i < all.length; i += LINES_PER_DELTA) {
        const piece =
          all.slice(i, i + LINES_PER_DELTA).join('\n') +
          (i + LINES_PER_DELTA < all.length ? '\n' : '')
        send('response.output_text.delta', {
          output_index: 0,
          item_id: msgId,
          content_index: 0,
          delta: piece
        })
        await sleep(DELTA_GAP_MS)
      }
      send('response.output_text.done', { output_index: 0, item_id: msgId, content_index: 0, text })
      const part = { type: 'output_text', text, annotations: [] }
      send('response.content_part.done', {
        output_index: 0,
        item_id: msgId,
        content_index: 0,
        part
      })
      const item = {
        type: 'message',
        role: 'assistant',
        id: msgId,
        status: 'completed',
        content: [part]
      }
      send('response.output_item.done', { output_index: 0, item })
      send('response.completed', {
        response: {
          ...base,
          status: 'completed',
          output: [item],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 }
          }
        }
      })
      res.end()
    })
  })
  .listen(PORT, '127.0.0.1')
