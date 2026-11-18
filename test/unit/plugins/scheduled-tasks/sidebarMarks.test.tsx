// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { CronMark } from '../../../../src/plugins/scheduled-tasks/renderer/sidebarMarks'

afterEach(cleanup)

describe('the scheduled-job mark on a sidebar row', () => {
  it('says on hover that a scheduled job started the session', () => {
    const { container } = render(<CronMark />)
    expect(container.querySelector('.ws-tab-cron')?.getAttribute('title')).toBe(
      'started by a scheduled job'
    )
  })
})
