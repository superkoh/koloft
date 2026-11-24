#!/usr/bin/env node
const fs = require('fs')
const http = require('http')

const [port, title, reply, log, turnTakesMs] = process.argv.slice(2)
const STREAM = /\/models\/([^/:]+):streamGenerateContent/

function lastUserText(request) {
  const turns = (request.contents ?? []).filter((c) => c.role === 'user')
  const parts = turns.length ? (turns[turns.length - 1].parts ?? []) : []
  return parts.map((p) => p.text ?? '').join('')
}

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const model = STREAM.exec(req.url)?.[1]
      if (!model) {
        res.writeHead(404).end()
        return
      }
      let request = {}
      try {
        request = JSON.parse(body)
      } catch {}
      const tools = (request.tools ?? []).flatMap((t) => t.functionDeclarations ?? []).length
      fs.appendFileSync(
        log,
        JSON.stringify({
          model,
          key: req.headers['x-goog-api-key'],
          tools,
          asked: lastUserText(request)
        }) + '\n'
      )
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      setTimeout(
        () =>
          res.end(
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: tools ? reply : title }] },
                  finishReason: 'STOP'
                }
              ],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
            })}\n\n`
          ),
        tools ? Number(turnTakesMs) : 0
      )
    })
  })
  .listen(Number(port), '127.0.0.1')
