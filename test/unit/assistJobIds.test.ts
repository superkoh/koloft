import { describe, expect, it } from 'vitest'
import type { Assist } from '@core/assistModels'
import type { SessionsAssistJobId } from '@plugins/sessions/shared/assistJobs'
import type { WorkbenchAssistJobId } from '@plugins/workbench/shared/assistJobs'
import type { ButlerAssistJobId } from '@plugins/butler/shared/assistJobs'

describe('Assist job ids', () => {
  it('a caller can only ask for a job its plugin registers, so a misspelled id fails the typecheck', async () => {
    const sessions: Assist<SessionsAssistJobId> = async (job) => job.row
    const workbench: Assist<WorkbenchAssistJobId> = async (job) => job.row
    const butler: Assist<ButlerAssistJobId> = async (job) => job.row
    const job = { system: '', prompt: '' }
    expect(await sessions({ row: 'title', ...job })).toBe('title')
    // @ts-expect-error
    await sessions({ row: 'titel', ...job })
    // @ts-expect-error
    await workbench({ row: 'title', ...job })
    // @ts-expect-error
    await butler({ row: 'docs', ...job })
  })
})
