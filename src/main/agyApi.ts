import http from 'http'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { record } from './codexObservation'
import type { QuestionAnswer } from './discord/dialog'

const exec = promisify(execFile)

// AGY§16
const SERVICE = '/exa.language_server_pb.LanguageServerService/'
const CSRF_HEADER = 'x-codeium-csrf-token'
const CALL_TIMEOUT_MS = 15_000
const FIND_TIMEOUT_MS = 5_000

class ApiError extends Error {
  constructor(
    readonly status: number,
    body: string
  ) {
    super(`agy API ${status}: ${body.slice(0, 200)}`)
  }
}

function post(port: number, token: string, method: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: SERVICE + method,
        method: 'POST',
        timeout: CALL_TIMEOUT_MS,
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: token }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new ApiError(res.statusCode ?? 0, text))
          try {
            resolve(text ? JSON.parse(text) : {})
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('agy API timed out')))
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

// AGY§16
async function listeningPorts(pid: number): Promise<number[]> {
  const { stdout } = await exec(
    'lsof',
    ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
    { timeout: FIND_TIMEOUT_MS }
  ).catch(() => ({ stdout: '' }))
  return [
    ...new Set(
      stdout
        .split('\n')
        .flatMap((line) => (line.startsWith('n') ? [Number(/:(\d+)$/.exec(line)?.[1])] : []))
        .filter((port) => Number.isInteger(port) && port > 0)
    )
  ]
}

export interface PendingInteraction {
  trajectoryId: string
  stepIndex: number
  kind: 'command' | 'file' | 'question'
  target?: string
  questions?: { question: string; options: { id: string; text: string }[]; multiSelect?: true }[]
}

const WAITING = 'CORTEX_STEP_STATUS_WAITING'

// AGY§16
function pendingOf(trajectory: Record<string, unknown>): PendingInteraction | undefined {
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : []
  const stepIndex = steps.length - 1
  const step = record(steps[stepIndex])
  if (step.status !== WAITING || typeof trajectory.trajectoryId !== 'string') return undefined
  const asked = record(step.requestedInteraction)
  const base = { trajectoryId: trajectory.trajectoryId, stepIndex }
  const resource = record(record(asked.permission).resource)
  if (resource.action === 'command' || resource.action === 'write_file')
    return {
      ...base,
      kind: resource.action === 'command' ? 'command' : 'file',
      target: typeof resource.target === 'string' ? resource.target : undefined
    }
  const questions = record(asked.askQuestion).questions
  if (!Array.isArray(questions)) return undefined
  return {
    ...base,
    kind: 'question',
    questions: questions.map((q) => {
      const r = record(q)
      return {
        question: typeof r.question === 'string' ? r.question : '',
        options: (Array.isArray(r.options) ? r.options : []).map((o) => {
          const opt = record(o)
          return { id: String(opt.id ?? ''), text: typeof opt.text === 'string' ? opt.text : '' }
        }),
        ...(r.isMultiSelect === true && { multiSelect: true as const })
      }
    })
  }
}

// AGY§16
function latestUserConfig(trajectory: Record<string, unknown>): unknown {
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : []
  for (let i = steps.length - 1; i >= 0; i--) {
    const config = record(record(steps[i]).userInput).userConfig
    if (config && typeof config === 'object') return config
  }
  return undefined
}

export class AgyApi {
  private port?: number

  constructor(
    private pid: number,
    private token: string
  ) {}

  // AGY§16
  private async call(method: string, body: unknown): Promise<unknown> {
    if (this.port) {
      try {
        return await post(this.port, this.token, method, body)
      } catch (error) {
        if (error instanceof ApiError && error.status !== 404) throw error
        this.port = undefined
      }
    }
    for (const port of await listeningPorts(this.pid)) {
      try {
        await post(port, this.token, 'GetStatus', {})
      } catch {
        continue
      }
      this.port = port
      return post(port, this.token, method, body)
    }
    throw new Error('agy API not found')
  }

  private async trajectory(conversationId: string): Promise<Record<string, unknown>> {
    return record(
      record(await this.call('GetCascadeTrajectory', { cascadeId: conversationId })).trajectory
    )
  }

  async pending(conversationId: string): Promise<PendingInteraction | undefined> {
    return pendingOf(await this.trajectory(conversationId))
  }

  // AGY§13
  async backgroundTaskIds(conversationId: string): Promise<Set<string>> {
    const tasks = record(
      await this.call('ListBackgroundTasks', { cascadeId: conversationId })
    ).tasks
    return new Set(
      (Array.isArray(tasks) ? tasks : []).flatMap((t) => {
        const id = record(record(t).task).taskId
        return typeof id === 'string' ? [id] : []
      })
    )
  }

  // AGY§16
  async send(conversationId: string, text: string): Promise<boolean> {
    const cascadeConfig = latestUserConfig(await this.trajectory(conversationId))
    if (!cascadeConfig) return false
    await this.call('SendUserCascadeMessage', {
      cascadeId: conversationId,
      items: [{ text }],
      cascadeConfig
    })
    return true
  }

  // AGY§16
  async rename(conversationId: string, title: string): Promise<void> {
    await this.call('UpdateConversationAnnotations', {
      cascadeId: conversationId,
      annotations: { title },
      mergeAnnotations: true
    })
  }

  // AGY§16
  async allow(conversationId: string, pending: PendingInteraction, allow: boolean): Promise<void> {
    await this.call('HandleCascadeUserInteraction', {
      cascadeId: conversationId,
      interaction: {
        trajectoryId: pending.trajectoryId,
        stepIndex: pending.stepIndex,
        permission: { allow }
      }
    })
  }

  // AGY§16
  async answer(
    conversationId: string,
    pending: PendingInteraction,
    answers: QuestionAnswer[]
  ): Promise<void> {
    const responses = (pending.questions ?? []).map(({ question, options }, i) => {
      const a = answers[i]!
      return 'pick' in a
        ? { question, selectedOptionIds: [options[a.pick - 1]!.id] }
        : { question, writeInResponse: a.words }
    })
    await this.call('HandleCascadeUserInteraction', {
      cascadeId: conversationId,
      interaction: {
        trajectoryId: pending.trajectoryId,
        stepIndex: pending.stepIndex,
        askQuestion: { responses }
      }
    })
  }

  // AGY§16 AGY§17
  streamState(
    conversationId: string,
    onMessage: (message: Record<string, unknown>) => void
  ): { close(): void } {
    let req: http.ClientRequest | undefined
    let closed = false
    const start = async (): Promise<void> => {
      await this.call('GetStatus', {})
      if (closed || !this.port) return
      const payload = Buffer.from(JSON.stringify({ conversationId }))
      const head = Buffer.alloc(5)
      head.writeUInt32BE(payload.length, 1)
      req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path: SERVICE + 'StreamAgentStateUpdates',
          method: 'POST',
          headers: {
            'content-type': 'application/connect+json',
            'connect-protocol-version': '1',
            [CSRF_HEADER]: this.token
          }
        },
        (res) => {
          let buf = Buffer.alloc(0)
          res.on('data', (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk])
            while (buf.length >= 5) {
              const len = buf.readUInt32BE(1)
              if (buf.length < 5 + len) break
              const flags = buf.readUInt8(0)
              const text = buf.subarray(5, 5 + len).toString('utf8')
              buf = buf.subarray(5 + len)
              if (flags !== 0) continue
              try {
                onMessage(record(JSON.parse(text)))
              } catch {}
            }
          })
        }
      )
      req.on('error', () => undefined)
      req.end(Buffer.concat([head, payload]))
    }
    void start().catch(() => undefined)
    return {
      close: () => {
        closed = true
        req?.destroy()
      }
    }
  }
}

// AGY§17
export function activeHookName(message: Record<string, unknown>): string | undefined {
  const hook = record(message.activeHook)
  return typeof hook.hookName === 'string' ? hook.hookName : undefined
}
