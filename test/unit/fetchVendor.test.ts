import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'crypto'
import http from 'http'
import type { AddressInfo } from 'net'
import { createRequire } from 'module'

const { download } = createRequire(__filename)('../../scripts/fetch-vendor.cjs') as {
  download: (url: string, sha256: string) => Promise<Buffer>
}

const BODY = Buffer.from('vendored file')
const BODY_SHA = createHash('sha256').update(BODY).digest('hex')

const servers: http.Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

async function serve(statuses: number[]): Promise<{ url: string; hits: () => number }> {
  let hits = 0
  const server = http.createServer((_req, res) => {
    const status = statuses[hits++] ?? 200
    if (status === 200) res.end(BODY)
    else res.writeHead(status, { 'Retry-After': '0' }).end()
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

  it('fails at once on a status that another try cannot fix', async () => {
    const server = await serve([404])
    await expect(download(server.url, BODY_SHA)).rejects.toThrow('download failed: 404')
    expect(server.hits()).toBe(1)
  })
})
