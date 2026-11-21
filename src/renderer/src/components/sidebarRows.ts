import { createContext, type JSX } from 'react'
import type { WorkspaceRows } from '@shared/types'

export type SessionRowsOf = (ws: WorkspaceRows) => JSX.Element[]

export const SessionRowsOfContext = createContext<SessionRowsOf>(() => [])
