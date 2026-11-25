export class CodexRpcThatListsNoHooks {
  request = async (
    method: string,
    params: { cwds?: string[] }
  ): Promise<{ data: unknown[]; nextCursor?: null }> =>
    method === 'hooks/list'
      ? {
          data: (params.cwds ?? []).map((cwd) => ({ cwd, hooks: [], warnings: [], errors: [] }))
        }
      : { data: [], nextCursor: null }

  close = async (): Promise<void> => {}
}

const HOOK_OVERRIDE = /^hooks\.([A-Za-z]+)=/
const COMMAND_IN_IT = /command=("(?:[^"\\]|\\.)*")/g

export class CodexRpcThatTrustsEveryHookItIsGiven {
  private hooks: { eventName: string; command: string; key: string }[]

  constructor(options: { configOverrides?: string[] }) {
    this.hooks = (options.configOverrides ?? []).flatMap((override) => {
      const event = HOOK_OVERRIDE.exec(override)?.[1]
      if (!event) return []
      return [...override.matchAll(COMMAND_IN_IT)].map((m, group) => ({
        eventName: event,
        command: JSON.parse(m[1]) as string,
        key: `/<session-flags>/config.toml:${event}:${group}:0`
      }))
    })
  }

  request = async (
    method: string,
    params: { cwds?: string[] }
  ): Promise<{ data: unknown[]; nextCursor?: null }> =>
    method === 'hooks/list'
      ? {
          data: (params.cwds ?? []).map((cwd) => ({
            cwd,
            hooks: this.hooks.map((hook) => ({
              ...hook,
              source: 'sessionFlags',
              currentHash: 'sha256:pinned',
              trustStatus: 'trusted'
            })),
            warnings: [],
            errors: []
          }))
        }
      : { data: [], nextCursor: null }

  close = async (): Promise<void> => {}
}
