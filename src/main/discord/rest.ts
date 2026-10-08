import { sleep } from '../codexTransport'

const USER_AGENT = 'DiscordBot (https://github.com/superkoh/koloft, 1)'
const NO_CONTENT = 204

export class DiscordHttpError extends Error {
  constructor(
    readonly status: number,
    route: string
  ) {
    super(`Discord answered ${status} to ${route}`)
  }
}

function bucketOf(route: string): string {
  const message = /^\/channels\/(\d+)\/messages/.exec(route)
  return message ? `channel:${message[1]}` : route
}

// ADR-0027 PLATFORM§39
export class DiscordRest {
  private queues = new Map<string, Promise<unknown>>()

  constructor(
    private apiUrl: string,
    private token: string
  ) {}

  request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const bucket = bucketOf(route)
    const sent = (this.queues.get(bucket) ?? Promise.resolve()).then(() =>
      this.send<T>(method, route, body)
    )
    this.queues.set(
      bucket,
      sent.catch(() => undefined)
    )
    return sent
  }

  sent(route: string): Promise<unknown> {
    return this.queues.get(bucketOf(route)) ?? Promise.resolve()
  }

  private async send<T>(method: string, route: string, body?: unknown): Promise<T> {
    const form = body instanceof FormData
    for (;;) {
      const res = await fetch(this.apiUrl + route, {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          'User-Agent': USER_AGENT,
          ...(body === undefined || form ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body)
      })
      if (res.status === 429) {
        const { retry_after } = (await res.json()) as { retry_after: number }
        await sleep(retry_after * 1000)
        continue
      }
      if (!res.ok) throw new DiscordHttpError(res.status, route)
      return (res.status === NO_CONTENT ? undefined : await res.json()) as T
    }
  }
}
