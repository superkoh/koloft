export interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_1h_input_tokens?: number }
  cache_read_input_tokens?: number
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input?: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  is_error?: boolean
  content?: unknown
}

export interface ImageBlock {
  type: 'image'
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock

export interface Origin {
  kind?: string
}

// CC§8
export interface ToolUseResult {
  status?: string
  background?: boolean
  backgroundTaskId?: string
  taskId?: string
  timeoutMs?: number
  agentId?: string
}

// CC§1 CC§2 CC§8 CC§9 CC§13
export interface TranscriptRecord {
  type?: string
  cwd?: string
  timestamp?: string
  version?: string
  requestId?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  origin?: Origin
  message?: {
    id?: string
    model?: string
    content?: string | ContentBlock[]
    usage?: Usage
  }
  toolUseResult?: ToolUseResult
  attachment?: {
    type?: string
    commandMode?: string
    prompt?: string
    origin?: Origin
  }
  content?: string
  summary?: string
  aiTitle?: string
  customTitle?: string
  relocatedCwd?: string
  worktreeSession?: Record<string, unknown> | null
}

export function parseRecord(line: string): TranscriptRecord | null {
  if (!line) return null
  try {
    const parsed: unknown = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? (parsed as TranscriptRecord) : null
  } catch {
    return null
  }
}
