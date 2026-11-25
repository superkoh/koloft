import { basename } from '@shared/preview'

const LINE_KEEPS_CHARS = 200

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, LINE_KEEPS_CHARS)
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export const ran = (command: string): string => `Ran ${oneLine(command)}`
export const edited = (file: string): string => `Edited ${basename(file)}`
export const wrote = (file: string): string => `Wrote ${basename(file)}`
export const read = (file: string): string => `Read ${basename(file)}`
export const used = (tool: string): string => `Used ${oneLine(tool)}`
export const searched = (what: string): string => `Searched for ${oneLine(what)}`
export const searchedTheWeb = (query: string): string => `Searched the web for ${oneLine(query)}`
export const opened = (url: string): string => `Opened ${oneLine(url)}`
export const startedAHelper = (label: string): string => `Started a helper: ${oneLine(label)}`
