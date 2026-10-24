import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { agyTranscript, summariesDb } from '../../../src/main/agyStore'

export interface SummaryFixture {
  conversation_id: string
  title?: string
  preview?: string
  workspace_uris?: string
  last_modified_time?: string
  step_count?: number
  parent_conversation_id?: string
  app_data_dir?: string
  dbRemoved?: true
}

const conversationDbOf = (geminiDir: string, id: string): string =>
  path.join(path.dirname(summariesDb(geminiDir)), 'conversations', `${id}.db`)

const SUMMARY_COLUMNS = [
  'conversation_id',
  'title',
  'preview',
  'workspace_uris',
  'last_modified_time',
  'step_count',
  'parent_conversation_id',
  'app_data_dir'
] as const

export function writeSummaries(geminiDir: string, rows: SummaryFixture[]): void {
  const file = summariesDb(geminiDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec(`create table if not exists conversation_summaries (
      conversation_id text primary key,
      title text not null default '',
      preview text not null default '',
      workspace_uris text not null default '',
      last_modified_time text not null default '',
      step_count integer not null default 0,
      parent_conversation_id text not null default '',
      app_data_dir text not null default ''
    )`)
    const insert = db.prepare(
      `insert or replace into conversation_summaries (${SUMMARY_COLUMNS.join(', ')}) values (${SUMMARY_COLUMNS.map(() => '?').join(', ')})`
    )
    for (const row of rows) {
      if (!row.dbRemoved) {
        const conversation = conversationDbOf(geminiDir, row.conversation_id)
        fs.mkdirSync(path.dirname(conversation), { recursive: true })
        fs.closeSync(fs.openSync(conversation, 'a'))
      }
      insert.run(
        row.conversation_id,
        row.title ?? '',
        row.preview ?? '',
        row.workspace_uris ?? '[]',
        row.last_modified_time ?? '0001-01-01 00:00:00+00:00',
        row.step_count ?? 1,
        row.parent_conversation_id ?? '',
        row.app_data_dir ?? ''
      )
    }
  } finally {
    db.close()
  }
}

export interface StepFixture {
  type: string
  content?: string
  created_at?: string
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
}

export function appendTranscript(file: string, steps: StepFixture[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, steps.map((s) => JSON.stringify(s) + '\n').join(''))
}

export function appendConversation(geminiDir: string, id: string, steps: StepFixture[]): void {
  appendTranscript(agyTranscript(geminiDir, id), steps)
}

export const ownerTyped = (words: string): string =>
  `<USER_REQUEST>\n${words}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-16T16:04:11+08:00.\n</ADDITIONAL_METADATA>`
