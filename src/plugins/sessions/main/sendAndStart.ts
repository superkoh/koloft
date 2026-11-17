export interface SendResult {
  ok: boolean
  session?: string
  text?: string
  why?: string
}

export interface StartResult {
  ok: boolean
  session?: string
  name?: string
  why?: string
}

export interface StartSpec {
  task: string
  workspace?: string
  backend?: string
  model?: string
  name?: string
  worktree?: string
}
