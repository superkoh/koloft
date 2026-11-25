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
  private hooks: { eventName: string; command: string }[]

  constructor(options: { configOverrides?: string[] }) {
    this.hooks = (options.configOverrides ?? []).flatMap((override) => {
      const event = HOOK_OVERRIDE.exec(override)?.[1]
      if (!event) return []
      return [...override.matchAll(COMMAND_IN_IT)].map((m) => ({
        eventName: event,
        command: JSON.parse(m[1]) as string
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
            hooks: this.hooks.map((hook, i) => ({
              ...hook,
              key: `/<session-flags>/config.toml:${hook.eventName}:${this.hooks.slice(0, i).filter((h) => h.eventName === hook.eventName).length}:0`,
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
