import http from 'http'
import { spawnSync } from 'child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgyApi, agentStateUpdate, type PendingInteraction } from '../../src/agents/agy/main/agyApi'

const TOKEN = 'csrf-123'
const SERVICE = '/exa.language_server_pb.LanguageServerService/'

interface Call {
  method: string
  token: string | undefined
  body: unknown
}

let calls: Call[]
let trajectory: unknown
let backgroundTasksReply: unknown
let stream: (res: http.ServerResponse) => void
let httpsPort: http.Server
let apiPort: http.Server

function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

beforeAll(async () => {
  httpsPort = await listen((_req, res) => {
    res.writeHead(400)
    res.end('Client sent an HTTP request to an HTTPS server.')
  })
  apiPort = await listen((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const method = req.url!.slice(SERVICE.length)
      const raw = Buffer.concat(chunks)
      const token = req.headers['x-codeium-csrf-token'] as string | undefined
      if (method === 'StreamAgentStateUpdates') {
        calls.push({ method, token, body: JSON.parse(raw.subarray(5).toString('utf8')) })
        return stream(res)
      }
      calls.push({ method, token, body: JSON.parse(raw.toString('utf8')) })
      if (token !== TOKEN) {
        res.writeHead(401)
        return res.end('invalid CSRF token')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        method === 'GetCascadeTrajectory'
          ? JSON.stringify({ trajectory })
          : method === 'ListBackgroundTasks'
            ? JSON.stringify(backgroundTasksReply)
            : '{}'
      )
    })
  })
})

afterAll(() => {
  httpsPort.close()
  apiPort.close()
})

beforeEach(() => {
  calls = []
  trajectory = { trajectoryId: 't1', steps: [] }
  backgroundTasksReply = {}
  stream = (res) => res.end()
})

const api = (): AgyApi => new AgyApi(process.pid, TOKEN)
const sent = (method: string): unknown[] =>
  calls.filter((c) => c.method === method).map((c) => c.body)
const waiting = (requestedInteraction: unknown): unknown => ({
  trajectoryId: 't1',
  steps: [
    { status: 'CORTEX_STEP_STATUS_DONE' },
    { status: 'CORTEX_STEP_STATUS_WAITING', requestedInteraction }
  ]
})

describe('AgyApi (the local Connect API agy serves, AGY§16)', () => {
  it("finds agy's API among the ports its process listens on, and sends the tab's CSRF token with every call", async () => {
    await api().pending('c1')
    expect(sent('GetCascadeTrajectory')).toEqual([{ cascadeId: 'c1' }])
    expect(calls.every((c) => c.token === TOKEN)).toBe(true)
  })

  it("sends a message with the conversation's latest settings, and refuses when no turn has any to copy", async () => {
    trajectory = {
      trajectoryId: 't1',
      steps: [
        { userInput: { userConfig: { plannerConfig: { planModel: 'OLD' } } } },
        { userInput: { userConfig: { plannerConfig: { planModel: 'M36' } } } },
        { plannerResponse: {} }
      ]
    }
    expect(await api().send('c1', 'hello')).toBe(true)
    expect(sent('SendUserCascadeMessage')).toEqual([
      {
        cascadeId: 'c1',
        items: [{ text: 'hello' }],
        cascadeConfig: { plannerConfig: { planModel: 'M36' } }
      }
    ])
    calls = []
    trajectory = { trajectoryId: 't1', steps: [{ plannerResponse: {} }] }
    expect(await api().send('c1', 'hello')).toBe(false)
    expect(sent('SendUserCascadeMessage')).toEqual([])
  })

  it('reads a waiting step as a command, a file or a question, and a conversation with nothing waiting as no ask', async () => {
    trajectory = waiting({ permission: { resource: { action: 'command', target: 'ls -la' } } })
    expect(await api().pending('c1')).toEqual({
      trajectoryId: 't1',
      stepIndex: 1,
      kind: 'command',
      target: 'ls -la'
    })
    trajectory = waiting({ permission: { resource: { action: 'write_file', target: '/w/a.md' } } })
    expect(await api().pending('c1')).toMatchObject({ kind: 'file', target: '/w/a.md' })
    expect((await api().pending('c1'))?.read).toBeUndefined()
    // AGY§26
    trajectory = waiting({ permission: { resource: { action: 'read_file', target: '/o/b.md' } } })
    expect(await api().pending('c1')).toMatchObject({ kind: 'file', target: '/o/b.md', read: true })
    trajectory = waiting({
      askQuestion: {
        questions: [
          {
            question: 'Which fruit?',
            options: [
              { id: '1', text: 'Apple' },
              { id: '2', text: 'Banana' }
            ]
          }
        ]
      }
    })
    expect(await api().pending('c1')).toEqual({
      trajectoryId: 't1',
      stepIndex: 1,
      kind: 'question',
      questions: [
        {
          question: 'Which fruit?',
          options: [
            { id: '1', text: 'Apple' },
            { id: '2', text: 'Banana' }
          ]
        }
      ]
    })
    trajectory = { trajectoryId: 't1', steps: [{ status: 'CORTEX_STEP_STATUS_DONE' }] }
    expect(await api().pending('c1')).toBeUndefined()
  })

  it('answers an approval with allow or deny, and each question of an ask with the picked option id or the owner’s own words, for the step that waits', async () => {
    const ask: PendingInteraction = {
      trajectoryId: 't1',
      stepIndex: 4,
      kind: 'question',
      questions: [
        {
          question: 'Which fruit?',
          options: [
            { id: 'a', text: 'Apple' },
            { id: 'b', text: 'Banana' }
          ]
        },
        { question: 'Which size?', options: [{ id: 's', text: 'Small' }] }
      ]
    }
    await api().allow('c1', { ...ask, kind: 'command' }, false)
    await api().answer('c1', ask, [{ pick: 2 }, { words: 'Medium, please' }])
    expect(sent('HandleCascadeUserInteraction')).toEqual([
      {
        cascadeId: 'c1',
        interaction: { trajectoryId: 't1', stepIndex: 4, permission: { allow: false } }
      },
      {
        cascadeId: 'c1',
        interaction: {
          trajectoryId: 't1',
          stepIndex: 4,
          askQuestion: {
            responses: [
              { question: 'Which fruit?', selectedOptionIds: ['b'] },
              { question: 'Which size?', writeInResponse: 'Medium, please' }
            ]
          }
        }
      }
    ])
  })

  it('reads each message of the state stream, also one split across packets, and skips the end-of-stream frame', async () => {
    const frame = (flags: number, value: unknown): Buffer => {
      const body = Buffer.from(JSON.stringify(value))
      const head = Buffer.alloc(5)
      head.writeUInt8(flags, 0)
      head.writeUInt32BE(body.length, 1)
      return Buffer.concat([head, body])
    }
    stream = (res) => {
      res.writeHead(200, { 'content-type': 'application/connect+json' })
      const first = frame(0, { activeHook: { hookName: 'context_summary' } })
      res.write(first.subarray(0, 7))
      setTimeout(() => {
        res.write(Buffer.concat([first.subarray(7), frame(0, { status: 'IDLE' })]))
        res.end(frame(2, { error: 'eos' }))
      }, 20)
    }
    const got: Record<string, unknown>[] = []
    const live = api().streamState('c1', (m) => got.push(m))
    await vi.waitFor(() => expect(got).toHaveLength(2))
    live.close()
    expect(sent('StreamAgentStateUpdates')).toEqual([{ conversationId: 'c1' }])
    expect(got.map((m) => agentStateUpdate(m).activeHook)).toEqual(['context_summary', undefined])
    expect(got[1]).toEqual({ status: 'IDLE' })
  })

  it('preserves full TaskSnapshot metadata from ListBackgroundTasks and unwraps StreamAgentStateUpdates', async () => {
    backgroundTasksReply = {
      tasks: [
        {
          conversationId: 'c1',
          task: {
            taskId: 'c1/task-2',
            toolName: 'run_command',
            toolSummary: 'Dev server',
            description: 'npm run dev',
            isDaemon: true,
            startTime: '2026-11-18T00:00:00Z',
            stepIndex: 2,
            logUri: 'file:///tmp/task-2.log'
          }
        },
        {
          conversationId: 'c1',
          task: {
            taskId: 'c1/task-4',
            toolName: 'schedule',
            description: 'Timer: 30s',
            stepIndex: 4
          }
        }
      ]
    }
    expect(await api().backgroundTasks('c1')).toEqual([
      {
        taskId: 'c1/task-2',
        conversationId: 'c1',
        toolName: 'run_command',
        toolSummary: 'Dev server',
        description: 'npm run dev',
        isDaemon: true,
        startTime: Date.parse('2026-11-18T00:00:00Z'),
        stepIndex: 2,
        logUri: 'file:///tmp/task-2.log'
      },
      {
        taskId: 'c1/task-4',
        conversationId: 'c1',
        toolName: 'schedule',
        description: 'Timer: 30s',
        stepIndex: 4
      }
    ])
    expect(
      agentStateUpdate({
        update: {
          conversationId: 'c1',
          status: 'CASCADE_RUN_STATUS_IDLE',
          activeHook: { hookName: 'context_summary' },
          backgroundTasksUpdate: {
            totalLength: 1,
            backgroundTasks: [
              {
                taskSnapshot: {
                  taskId: 'c1/task-2',
                  toolName: 'run_command',
                  description: 'npm run dev',
                  isDaemon: true
                }
              }
            ]
          }
        }
      })
    ).toEqual({
      conversationId: 'c1',
      status: 'CASCADE_RUN_STATUS_IDLE',
      activeHook: 'context_summary',
      backgroundTasksTotal: 1,
      backgroundTasks: [
        {
          taskId: 'c1/task-2',
          conversationId: 'c1',
          toolName: 'run_command',
          description: 'npm run dev',
          isDaemon: true
        }
      ]
    })
    expect(
      agentStateUpdate({
        update: {
          conversationId: 'c1',
          status: 'CASCADE_RUN_STATUS_IDLE',
          fullyIdle: true,
          backgroundTasksUpdate: {}
        }
      })
    ).toEqual({
      conversationId: 'c1',
      status: 'CASCADE_RUN_STATUS_IDLE',
      fullyIdle: true,
      backgroundTasksTotal: 0,
      backgroundTasks: []
    })
  })

  it('fails when the process serves no API', async () => {
    const gone = spawnSync('/usr/bin/true').pid
    await expect(new AgyApi(gone, TOKEN).pending('c1')).rejects.toThrow(/not found/)
  })
})
