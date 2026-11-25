// ADR-0054
import { agent as claude } from './claude/agent'
import { agent as codex } from './codex/agent'
import { agent as agy } from './agy/agent'

export const AGENTS = [claude, codex, agy] as const

export const PICKED_ON_FIRST_OPEN = claude

export const OWNER_OF_UNNAMED_OLD_DATA: string = 'claude'
