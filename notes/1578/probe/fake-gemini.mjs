import http from 'http'
import fs from 'fs'

const port = Number(process.argv[2] ?? 47811)
const log = process.argv[3]
const LINES = 160

function reply(base) {
  const out = ['Here is the long answer.', '']
  for (let i = 1; i <= LINES; i++) {
    out.push(
      `${i}. Line ${i}: see [doc ${i}](${base}/link-${i}) and also ${base}/bare-${i} for the details of part ${i}.`
    )
  }
  out.push('', 'END-OF-REPLY')
  return out.join('\n')
}

http
  .createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      if (log) fs.appendFileSync(log, `${req.method} ${req.url}\n`)
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<html><body>page ${req.url}</body></html>`)
        return
      }
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {}
      const text = body.tools ? reply(`http://127.0.0.1:${port}`) : 'Probe title'
      const ev = {
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
      }
      const data = 'data: ' + JSON.stringify(ev) + '\n\n'
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'content-length': Buffer.byteLength(data)
      })
      res.end(data)
    })
  })
  .listen(port, '127.0.0.1')
