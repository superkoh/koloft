import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'
import http from 'http'
import type { AddressInfo } from 'net'
// @ts-expect-error
import { download as untypedDownload } from '../../scripts/fetch-vendor.cjs'

const download = untypedDownload as (url: string, sha256: string) => Promise<Buffer>

const BODY = Buffer.from('vendored file')
const BODY_SHA = createHash('sha256').update(BODY).digest('hex')
const DROP_CONNECTION = 0

const servers: http.Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    await new Promise((r) => s.close(r))
  }
})

async function serve(statuses: number[]): Promise<{ url: string; hits: () => number }> {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let hits = 0
  const server = http.createServer((req, res) => {
    const status = statuses[hits++] ?? 200
    if (status === DROP_CONNECTION) req.socket.destroy()
    else if (status === 200) res.end(BODY)
    else res.writeHead(status, { 'Retry-After': '0' }).end('slow down')
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/file`, hits: () => hits }
}

describe('fetch-vendor download', () => {
  it('waits out a rate limit or a server error and downloads the file on a later try', async () => {
    const server = await serve([429, 503])
    await expect(download(server.url, BODY_SHA)).resolves.toEqual(BODY)
    expect(server.hits()).toBe(3)
  })

  it('tries again after a dropped connection', async () => {
    const server = await serve([DROP_CONNECTION])
    await expect(download(server.url, BODY_SHA)).resolves.toEqual(BODY)
    expect(server.hits()).toBe(2)
  })

  it('fails at once on a status that another try cannot fix', async () => {
    const server = await serve([404])
    await expect(download(server.url, BODY_SHA)).rejects.toThrow('download failed: 404')
    expect(server.hits()).toBe(1)
  })
})
