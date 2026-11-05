import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

const [relayPort, sockDir] = process.argv.slice(2)

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 4000 }, (res) => {
      res.resume()
      res.on('end', () => resolve(`status ${res.statusCode}`))
    })
    req.on('error', (e) => resolve(`error ${e.code || e.message}`))
    req.on('timeout', () => {
      req.destroy()
      resolve('error timeout')
    })
  })
}

function unixRoundTrip(dir) {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (e) {
      resolve(`mkdir ${e.code}`)
      return
    }
    const sock = path.join(dir, 'probe.sock')
    try {
      fs.rmSync(sock, { force: true })
    } catch {}
    const server = net.createServer((c) => c.end('pong'))
    server.on('error', (e) => resolve(`listen ${e.code}`))
    server.listen(sock, () => {
      const c = net.connect(sock)
      let got = ''
      c.on('data', (d) => (got += d))
      c.on('end', () => {
        server.close()
        resolve(`ok ${got}`)
      })
      c.on('error', (e) => {
        server.close()
        resolve(`connect ${e.code}`)
      })
    })
  })
}

const out = {
  proxyEnvCount: Object.keys(process.env).filter((k) => /proxy/i.test(k)).length,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  NO_PROXY: process.env.NO_PROXY,
  NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY,
  CODEX_NETWORK_PROXY_ACTIVE: process.env.CODEX_NETWORK_PROXY_ACTIVE,
  nodeDirectRelay: await get(`http://127.0.0.1:${relayPort}/`),
  unixSocket: sockDir ? await unixRoundTrip(sockDir) : 'skipped'
}
console.log('CLIENT ' + JSON.stringify(out))
