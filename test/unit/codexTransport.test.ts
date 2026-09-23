import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { once } from 'events'
import WebSocket from 'ws'
import {
  CodexRpc,
  codexEnvironment,
  createCodexTransport,
  type CodexFrame
} from '../../src/main/codexTransport'

let directory: string
let binary: string
const cleanups: (() => Promise<void>)[] = []

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-wire-test-'))
  binary = path.join(directory, 'codex')
  await fs.writeFile(
    binary,
    `#!${process.execPath}
const {spawn} = require('child_process');
const readline = require('readline');
let initialized = false;
const out = obj => process.stdout.write(JSON.stringify(obj) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const f=JSON.parse(line);
 if(f.method==='initialize') {out({id:f.id,result:{userAgent:'fake'}});return;}
 if(f.method==='initialized') {initialized=true;return;}
 if(f.id===991 && !f.method) {out({method:'approval/received',params:f.result});return;}
 if(!initialized) {out({id:f.id,error:{message:'Not initialized'}});return;}
 const mode=f.params?.mode;
 if(mode==='hang') return;
 if(mode==='crash') {process.kill(process.pid,'SIGKILL');return;}
 if(mode==='partial') {process.stdout.write('{');process.exit(0);return;}
 if(mode==='oversize') {process.stdout.write('x'.repeat(2000));return;}
 if(mode==='approval') {out({id:991,method:'item/commandExecution/requestApproval',params:{command:'echo ok'}});return;}
 if(mode==='tree') {
   const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(0),10000)"],{detached:true,stdio:'ignore'});
   child.unref();
   out({id:f.id,result:{pid:process.pid,child:child.pid}});return;
 }
 if(mode==='utf8') {
   const bytes=Buffer.from(JSON.stringify({id:f.id,result:{title:'会话🙂'}})+'\\n');
   const offset=bytes.indexOf(Buffer.from('会'))+1;
   process.stdout.write(bytes.subarray(0,offset));
   setTimeout(()=>process.stdout.write(bytes.subarray(offset)),15);return;
 }
 out({id:f.id,result:{data:[],params:f.params,env:{home:process.env.CODEX_HOME,key:process.env.OPENAI_API_KEY,thread:process.env.CODEX_THREAD_ID,tab:process.env.KOLOFT_TAB_ID}}});
});
process.stdin.on('end',()=>process.exit(0));
`,
    { mode: 0o700 }
  )
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await fs.rm(directory, { recursive: true, force: true })
})

function rpc(options: { timeoutMs?: number; maxFrameBytes?: number } = {}): CodexRpc {
  const client = new CodexRpc({ binary, cwd: directory, ...options })
  cleanups.push(() => client.close())
  return client
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws+unix://${url.slice('unix://'.length)}:/`)
  await once(socket, 'open')
  return socket
}

function nextFrame(socket: WebSocket): Promise<CodexFrame> {
  return once(socket, 'message').then(([bytes]) => JSON.parse(bytes.toString()) as CodexFrame)
}

async function handshake(socket: WebSocket): Promise<void> {
  const reply = nextFrame(socket)
  socket.send(
    JSON.stringify({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'test', version: '1' } }
    })
  )
  await reply
  socket.send(JSON.stringify({ method: 'initialized' }))
}

describe('Codex stdio reads', () => {
  it('initializes before reads, keeps concurrent IDs separate, and decodes split UTF-8', async () => {
    const client = rpc()
    const [first, regular] = await Promise.all([
      client.request<{ params: unknown }>('thread/read', { threadId: 'first' }),
      client.request<{ params: unknown }>('thread/list', { cursor: 'next' })
    ])
    const unicode = await client.request<{ title: string }>('thread/read', { mode: 'utf8' })
    expect(first.params).toEqual({ threadId: 'first' })
    expect(unicode.title).toBe('会话🙂')
    expect(regular.params).toEqual({ cursor: 'next' })
    await expect(client.request('turn/start', {})).rejects.toThrow('does not allow')
  })

  it('rejects stalled requests and rejects pending reads when closed', async () => {
    const client = rpc({ timeoutMs: 1000 })
    await expect(client.request('thread/read', { mode: 'hang' })).rejects.toThrow('timed out')
    const pending = client.request('thread/read', { mode: 'hang' })
    const rejected = expect(pending).rejects.toThrow('closed')
    await client.close()
    await rejected
  })

  it('rejects missing binaries, incomplete JSONL and oversized frames', async () => {
    const missing = new CodexRpc({ binary: path.join(directory, 'missing'), cwd: directory })
    cleanups.push(() => missing.close())
    await expect(missing.request('thread/list')).rejects.toThrow()
    await expect(rpc().request('thread/read', { mode: 'partial' })).rejects.toThrow(
      /incomplete|exited/
    )
    await expect(
      rpc({ maxFrameBytes: 1024 }).request('thread/read', { mode: 'oversize' })
    ).rejects.toThrow('size limit')
  })

  it('preserves user auth/config but removes enclosing session markers', async () => {
    const client = new CodexRpc({
      binary,
      cwd: directory,
      env: {
        CODEX_HOME: directory,
        OPENAI_API_KEY: 'test-key',
        CODEX_THREAD_ID: 'other-run',
        KOLOFT_TAB_ID: 'other-tab'
      }
    })
    cleanups.push(() => client.close())
    const result = await client.request<{ env: unknown }>('thread/list')
    expect(result.env).toEqual({ home: directory, key: 'test-key' })
    const config = codexEnvironment({
      CODEX_CUSTOM_CONFIG: 'keep',
      CLAUDE_CODE_OAUTH_TOKEN: 'remove'
    })
    expect(config.CODEX_CUSTOM_CONFIG).toBe('keep')
    expect(config.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('remembers detached tool ownership after the app-server is killed', async () => {
    const client = rpc()
    const tree = await client.request<{ pid: number; child: number }>('thread/read', {
      mode: 'tree'
    })
    // longer than one process sample, so ownership of the detached child is on record
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await expect(client.request('thread/read', { mode: 'crash' })).rejects.toThrow('exited')
    await client.close()
    expect(() => process.kill(tree.child, 0)).toThrow()
  })

  it('can retry a failed stop without forgetting owned tool processes', async () => {
    const client = rpc()
    const tree = await client.request<{ pid: number; child: number }>('thread/read', {
      mode: 'tree'
    })
    const realKill = process.kill.bind(process)
    const killing = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (sig === 'SIGTERM')
        throw Object.assign(new Error('temporary signal failure'), { code: 'EPERM' })
      return realKill(pid, sig)
    })
    try {
      await expect(client.close()).rejects.toThrow('temporary signal failure')
    } finally {
      killing.mockRestore()
    }
    await client.close()
    expect(() => process.kill(tree.child, 0)).toThrow()
  })
})

describe('Codex TUI transport', () => {
  it('keeps approval requests on the TUI connection and observes both directions', async () => {
    const observed: { direction: string; frame: CodexFrame }[] = []
    const transport = await createCodexTransport({
      binary,
      cwd: directory,
      onFrame: (direction, frame) => observed.push({ direction, frame })
    })
    cleanups.push(() => transport.stop())
    const socketPath = transport.url.slice('unix://'.length)
    expect((await fs.stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700)
    expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600)
    const socket = await connect(transport.url)
    await handshake(socket)
    let reply = nextFrame(socket)
    socket.send(
      JSON.stringify(
        { id: 'tui-approval', method: 'thread/read', params: { mode: 'approval' } },
        null,
        2
      )
    )
    expect(await reply).toMatchObject({ id: 991, method: 'item/commandExecution/requestApproval' })
    reply = nextFrame(socket)
    socket.send(JSON.stringify({ id: 991, result: { decision: 'accept' } }))
    expect(await reply).toMatchObject({
      method: 'approval/received',
      params: { decision: 'accept' }
    })
    expect(observed).toContainEqual({
      direction: 'client',
      frame: { id: 991, result: { decision: 'accept' } }
    })
    expect(observed.some((e) => e.direction === 'server' && e.frame.id === 991)).toBe(true)
    const extra = new WebSocket(`ws+unix://${socketPath}:/`)
    await expect(once(extra, 'open')).rejects.toThrow('409')
    await transport.stop()
    await expect(fs.stat(socketPath)).rejects.toThrow()
  })

  it('disconnecting the TUI stops its server and detached tool child', async () => {
    let disconnected!: () => void
    const done = new Promise<void>((resolve) => {
      disconnected = resolve
    })
    const errors: Error[] = []
    const transport = await createCodexTransport({
      binary,
      cwd: directory,
      onFrame: () => {},
      onDisconnect: disconnected,
      onError: (e) => errors.push(e)
    })
    cleanups.push(() => transport.stop())
    const socket = await connect(transport.url)
    await handshake(socket)
    const reply = nextFrame(socket)
    socket.send(JSON.stringify({ id: 2, method: 'thread/read', params: { mode: 'tree' } }))
    const { result } = (await reply) as { result: { pid: number; child: number } }
    // Allow the child's SIGTERM handler to install, exercising forced termination.
    await new Promise((resolve) => setTimeout(resolve, 100))
    socket.close()
    await done
    for (const pid of [result.pid, result.child]) expect(() => process.kill(pid, 0)).toThrow()
    expect(errors).toEqual([])
  })

  it('an observer cannot rewrite TUI requests or stop their delivery by throwing', async () => {
    const errors: Error[] = []
    const transport = await createCodexTransport({
      binary,
      cwd: directory,
      onFrame: (_direction, frame) => {
        if (frame.method === 'thread/read') {
          frame.params = { changed: true }
          throw new Error('observer failed')
        }
      },
      onError: (error) => errors.push(error)
    })
    cleanups.push(() => transport.stop())
    const socket = await connect(transport.url)
    await handshake(socket)
    const reply = nextFrame(socket)
    socket.send(JSON.stringify({ id: 2, method: 'thread/read', params: { threadId: 'original' } }))
    expect(await reply).toMatchObject({ id: 2, result: { params: { threadId: 'original' } } })
    expect(errors.map((e) => e.message)).toEqual(['observer failed'])
  })

  it('rejects oversized peer input and stops instead of hanging on a partial write', async () => {
    const errors: Error[] = []
    const transport = await createCodexTransport({
      binary,
      cwd: directory,
      maxFrameBytes: 1024,
      onFrame: () => {},
      onError: (error) => errors.push(error)
    })
    cleanups.push(() => transport.stop())
    const socket = await connect(transport.url)
    const closed = once(socket, 'close')
    socket.send('x'.repeat(2000))
    await closed
    await transport.stop()
    expect(errors.some((error) => /payload|size/i.test(error.message))).toBe(true)
  })

  it('allows native confirmation to outlast the RPC deadline and cleans up on explicit stop', async () => {
    const errors: Error[] = []
    const transport = await createCodexTransport({
      binary,
      cwd: directory,
      timeoutMs: 50,
      onFrame: () => {},
      onError: (error) => errors.push(error)
    })
    cleanups.push(() => transport.stop())
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(errors).toEqual([])
    const socket = await connect(transport.url)
    await handshake(socket)
    await transport.stop()
    await expect(fs.stat(transport.url.slice('unix://'.length))).rejects.toThrow()
  })

  it('can retry endpoint cleanup after a filesystem failure', async () => {
    const transport = await createCodexTransport({ binary, cwd: directory, onFrame: () => {} })
    cleanups.push(() => transport.stop())
    const removing = vi
      .spyOn(fs, 'rm')
      .mockRejectedValueOnce(new Error('temporary filesystem failure'))
    try {
      await expect(transport.stop()).rejects.toThrow('temporary filesystem failure')
    } finally {
      removing.mockRestore()
    }
    await transport.stop()
    await expect(fs.stat(transport.url.slice('unix://'.length))).rejects.toThrow()
  })
})
