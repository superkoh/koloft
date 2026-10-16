#!/usr/bin/env node
const fs = require('fs')
const http = require('http')

const [port, command, log] = process.argv.slice(2)
let n = 0
http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      let request = {}
      try {
        request = JSON.parse(body)
      } catch {}
      const outputs = (request.input ?? []).filter((i) => i.type === 'function_call_output')
      fs.appendFileSync(log, JSON.stringify({ url: req.url, outputs }) + '\n')
      const send = (type, data) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const id = `resp_${++n}`
      send('response.created', { response: { id } })
      const item = outputs.length
        ? {
            type: 'message',
            role: 'assistant',
            id: `msg_${n}`,
            content: [{ type: 'output_text', text: 'fake model done' }]
          }
        : {
            type: 'function_call',
            name: 'exec_command',
            call_id: `call_${n}`,
            arguments: JSON.stringify({ cmd: command })
          }
      send('response.output_item.done', { item })
      send('response.completed', {
        response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
      })
      res.end()
    })
  })
  .listen(Number(port), '127.0.0.1')
