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
