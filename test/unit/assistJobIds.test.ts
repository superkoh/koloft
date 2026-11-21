import { describe, it } from 'vitest'
import type { Assist, AssistJob } from '@core/assistModels'
import type { SessionsAssistJobId } from '@plugins/sessions/shared/assistJobs'
import type { WorkbenchAssistJobId } from '@plugins/workbench/shared/assistJobs'
import type { ButlerAssistJobId } from '@plugins/butler/shared/assistJobs'

describe('Assist job ids', () => {
  it('a caller can only ask for a job its plugin registers, so a misspelled id fails the typecheck', () => {
    const job: Omit<AssistJob, 'row'> = { system: '', prompt: '' }
    const typedOnly = (
      sessions: Assist<SessionsAssistJobId>,
      workbench: Assist<WorkbenchAssistJobId>,
      butler: Assist<ButlerAssistJobId>
    ): void => {
      void sessions({ row: 'title', ...job })
      void workbench({ row: 'docs', ...job })
      void butler({ row: 'route', ...job })
      // @ts-expect-error
      void sessions({ row: 'titel', ...job })
      // @ts-expect-error
      void workbench({ row: 'title', ...job })
      // @ts-expect-error
      void butler({ row: 'docs', ...job })
    }
    void typedOnly
  })
})
