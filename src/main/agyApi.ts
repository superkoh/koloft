import http from 'http'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { nonEmptyString, record } from '@core/unknownValue'
import type { QuestionAnswer } from '@plugins/sessions/main/dialog'

const exec = promisify(execFile)

// AGY§16
export const SERVICE = '/exa.language_server_pb.LanguageServerService/'
export const CSRF_HEADER = 'x-codeium-csrf-token'
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

export interface AgyBackgroundTask {
  taskId: string
  toolName?: string
  toolSummary?: string
  description?: string
  startTime?: number
  stepIndex?: number
  logUri?: string
  isDaemon?: boolean
  conversationId: string
}

export interface AgyStateUpdate {
  conversationId?: string
  status?: string
  executorLoopStatus?: string
  fullyIdle?: boolean
  activeHook?: string
  backgroundTasks?: AgyBackgroundTask[]
  backgroundTasksTotal?: number
}

const str = nonEmptyString

function timeMs(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

// AGY§13
export function taskSnapshotOf(
  task: Record<string, unknown>,
  conversationId: string
): AgyBackgroundTask | undefined {
  const taskId = str(task.taskId)
  if (!taskId) return undefined
  const toolName = str(task.toolName)
  const toolSummary = str(task.toolSummary)
  const description = str(task.description)
  const startTime = timeMs(task.startTime)
  const stepIndex = typeof task.stepIndex === 'number' ? task.stepIndex : undefined
  const logUri = str(task.logUri)
  const isDaemon = typeof task.isDaemon === 'boolean' ? task.isDaemon : undefined
  return {
    taskId,
    conversationId,
    ...(toolName && { toolName }),
    ...(toolSummary && { toolSummary }),
    ...(description && { description }),
    ...(startTime !== undefined && { startTime }),
    ...(stepIndex !== undefined && { stepIndex }),
    ...(logUri && { logUri }),
    ...(isDaemon !== undefined && { isDaemon })
  }
}

export interface PendingInteraction {
  trajectoryId: string
  stepIndex: number
  kind: 'command' | 'file' | 'question'
  target?: string
  read?: true
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
  // AGY§26
  if (['command', 'write_file', 'read_file'].includes(String(resource.action)))
    return {
      ...base,
      kind: resource.action === 'command' ? 'command' : 'file',
      target: typeof resource.target === 'string' ? resource.target : undefined,
      ...(resource.action === 'read_file' && { read: true as const })
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
  private finding?: Promise<number | undefined>

  constructor(
    private pid: number,
    private token: string
  ) {}

  private findPort(): Promise<number | undefined> {
    return (this.finding ??= (async () => {
      try {
        for (const port of await listeningPorts(this.pid)) {
          try {
            await post(port, this.token, 'GetStatus', {})
            this.port = port
            return port
          } catch {
            continue
          }
        }
        return undefined
      } finally {
        this.finding = undefined
      }
    })())
  }

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
    const port = await this.findPort()
    if (port) return post(port, this.token, method, body)
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
  async backgroundTasks(conversationId: string): Promise<AgyBackgroundTask[]> {
    const tasks = record(
      await this.call('ListBackgroundTasks', { cascadeId: conversationId })
    ).tasks
    return (Array.isArray(tasks) ? tasks : []).flatMap((t) => {
      const entry = record(t)
      const parsed = taskSnapshotOf(record(entry.task), str(entry.conversationId) ?? conversationId)
      return parsed ? [parsed] : []
    })
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
      if ('words' in a) return { question, writeInResponse: a.words }
      const picks = 'pick' in a ? [a.pick] : a.picks
      return { question, selectedOptionIds: picks.map((n) => options[n - 1]!.id) }
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
            if (closed) return
            buf = Buffer.concat([buf, chunk])
            while (!closed && buf.length >= 5) {
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

// AGY§16 AGY§17
export function agentStateUpdate(message: Record<string, unknown>): AgyStateUpdate {
  const update = 'update' in message ? record(message.update) : message
  const conversationId = str(update.conversationId)
  const status = str(update.status)
  const executorLoopStatus = str(update.executorLoopStatus)
  const fullyIdle = typeof update.fullyIdle === 'boolean' ? update.fullyIdle : undefined
  const activeHook = str(record(update.activeHook).hookName)
  const hasBtu =
    'backgroundTasksUpdate' in update &&
    update.backgroundTasksUpdate !== null &&
    typeof update.backgroundTasksUpdate === 'object'
  const btu = record(update.backgroundTasksUpdate)
  const rawList = Array.isArray(btu.backgroundTasks)
    ? btu.backgroundTasks
    : Array.isArray(update.backgroundTasks)
      ? update.backgroundTasks
      : hasBtu && btu.totalLength === undefined && !Array.isArray(btu.indices)
        ? []
        : undefined
  const backgroundTasks = rawList?.flatMap((entry) => {
    const e = record(entry)
    const snap = 'taskSnapshot' in e ? record(e.taskSnapshot) : 'task' in e ? record(e.task) : e
    const parsed = taskSnapshotOf(snap, conversationId ?? '')
    return parsed ? [parsed] : []
  })
  const backgroundTasksTotal =
    typeof btu.totalLength === 'number'
      ? btu.totalLength
      : hasBtu && !Array.isArray(btu.indices) && !Array.isArray(btu.backgroundTasks)
        ? 0
        : Array.isArray(update.backgroundTasks)
          ? update.backgroundTasks.length
          : undefined
  return {
    ...(conversationId && { conversationId }),
    ...(status && { status }),
    ...(executorLoopStatus && { executorLoopStatus }),
    ...(fullyIdle !== undefined && { fullyIdle }),
    ...(activeHook && { activeHook }),
    ...(backgroundTasks !== undefined && { backgroundTasks }),
    ...(backgroundTasksTotal !== undefined && { backgroundTasksTotal })
  }
}
