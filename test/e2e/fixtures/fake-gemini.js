#!/usr/bin/env node
const fs = require('fs')
const http = require('http')

const [port, reply, log, turnTakesMs] = process.argv.slice(2)
const TITLE = 'Stand-in title'
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
      if (!model) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      setTimeout(
        () =>
          res.end(
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: tools ? reply : TITLE }] },
                  finishReason: 'STOP'
                }
              ],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
            })}\n\n`
          ),
        tools ? Number(turnTakesMs ?? 0) : 0
      )
    })
  })
  .listen(Number(port), '127.0.0.1')
