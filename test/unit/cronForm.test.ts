import { describe, expect, it } from 'vitest'
import type { CronJob, Schedule, SkillSuggestion } from '@shared/types'
import { describeSchedule } from '@shared/schedule'
import {
  emptyFields,
  fieldsToSchedule,
  permissionAfterSwitch,
  forecastFor,
  histEnd,
  histText,
  histWhen,
  modelValue,
  scheduleToFields,
  suggest,
  validate,
  type JobFields
} from '../../src/renderer/src/cronForm'

const f = (over: Partial<JobFields> = {}): JobFields => ({ ...emptyFields(), ...over })

const good = (over: Partial<JobFields> = {}): JobFields =>
  f({ name: 'Nightly report', task: '/daily-report', at: '21:00', ...over })

describe('fieldsToSchedule (BB-E17)', () => {
  it('stores all seven day chips as a daily schedule, not a seven-entry weekly one', () => {
    const s = fieldsToSchedule(f({ whenKind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], at: '09:00' }))
    expect(s).toEqual({ kind: 'daily', at: '09:00' })
  })

  it('sorts and de-duplicates the day chips', () => {
    expect(fieldsToSchedule(f({ whenKind: 'weekly', days: [5, 1, 3, 1], at: '09:00' }))).toEqual({
      kind: 'weekly',
      days: [1, 3, 5],
      at: '09:00'
    })
  })

  it('says nothing for no days, a broken time or an out-of-range repeat', () => {
    expect(fieldsToSchedule(f({ whenKind: 'weekly', days: [], at: '09:00' }))).toBeNull()
    expect(fieldsToSchedule(f({ whenKind: 'daily', at: '' }))).toBeNull()
    expect(fieldsToSchedule(f({ whenKind: 'every', n: 90, unit: 'hours' }))).toBeNull()
  })

  it('describes the day sets the chips can make', () => {
    const weekend = fieldsToSchedule(f({ whenKind: 'weekly', days: [0, 6], at: '09:00' }))
    expect(weekend && describeSchedule(weekend)).toBe('Weekends at 9:00')
    const mwf = fieldsToSchedule(f({ whenKind: 'weekly', days: [1, 3, 5], at: '09:00' }))
    expect(mwf && describeSchedule(mwf)).toBe('Mon, Wed, Fri at 9:00')
  })
})

describe('scheduleToFields', () => {
  it('fills the chips the saved job lights, and leaves the others usable', () => {
    expect(scheduleToFields({ kind: 'weekly', days: [1, 2], at: '07:30' })).toEqual({
      whenKind: 'weekly',
      at: '07:30',
      days: [1, 2],
      n: 1,
      unit: 'hours'
    })
    expect(scheduleToFields({ kind: 'every', n: 30, unit: 'minutes' })).toEqual({
      whenKind: 'every',
      at: '09:00',
      days: [],
      n: 30,
      unit: 'minutes'
    })
    expect(scheduleToFields({ kind: 'daily', at: '21:00' }).whenKind).toBe('daily')
  })
})

describe('validate messages (§7.5)', () => {
  const cases: { why: string; fields: JobFields; field: keyof JobFields; msg: string }[] = [
    {
      why: 'name empty',
      fields: good({ name: '   ' }),
      field: 'name',
      msg: 'Give the job a name.'
    },
    {
      why: 'name has no letter or digit',
      fields: good({ name: '!!!' }),
      field: 'name',
      msg: 'Use at least one letter or digit in the name.'
    },
    {
      why: 'name too long',
      fields: good({ name: 'a'.repeat(81) }),
      field: 'name',
      msg: 'Keep the name under 80 characters.'
    },
    {
      why: 'name starts with a dash',
      fields: good({ name: '-name hello' }),
      field: 'name',
      msg: 'The name cannot start with a dash.'
    },
    { why: 'task empty', fields: good({ task: '  ' }), field: 'task', msg: 'Say what to run.' },
    {
      why: 'task starts with a dash',
      fields: good({ task: '-p hello' }),
      field: 'task',
      msg: 'The text cannot start with a dash.'
    },
    {
      why: 'task too long',
      fields: good({ task: '/x' + 'a'.repeat(4095) }),
      field: 'task',
      msg: 'Keep the text under 4096 characters.'
    },
    {
      why: 'no day picked',
      fields: good({ whenKind: 'weekly', days: [] }),
      field: 'days',
      msg: 'Pick at least one day.'
    },
    {
      why: 'the time box was cleared',
      fields: good({ at: '' }),
      field: 'at',
      msg: 'Use a time like 09:00.'
    },
    {
      why: 'a time that is not a time',
      fields: good({ at: '25:99' }),
      field: 'at',
      msg: 'Use a time like 09:00.'
    },
    {
      why: 'every 90 hours',
      fields: good({ whenKind: 'every', n: 90, unit: 'hours' }),
      field: 'n',
      msg: 'Use a whole number from 1 to 720 minutes or 1 to 24 hours.'
    },
    {
      why: 'every 0 minutes',
      fields: good({ whenKind: 'every', n: 0, unit: 'minutes' }),
      field: 'n',
      msg: 'Use a whole number from 1 to 720 minutes or 1 to 24 hours.'
    },
    {
      why: 'a model name with a space in it',
      fields: good({ model: 'other', modelOther: 'not a model' }),
      field: 'modelOther',
      msg: 'Use letters, digits, dots, colons, dashes or underscores.'
    },
    {
      why: 'Other… left empty',
      fields: good({ model: 'other', modelOther: '' }),
      field: 'modelOther',
      msg: 'Use letters, digits, dots, colons, dashes or underscores.'
    }
  ]

  for (const c of cases) {
    it(`refuses ${c.why}`, () => {
      const r = validate(c.fields)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.errors[c.field]).toBe(c.msg)
    })
  }

  it('accepts a filled-in form and hands back what save wants', () => {
    const r = validate(good({ whenKind: 'weekly', days: [1, 2, 3, 4, 5], at: '09:00' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.input).toEqual({
      backend: 'claude',
      name: 'Nightly report',
      task: '/daily-report',
      schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], at: '09:00' },
      permission: 'same',
      enabled: true
    })
    expect('model' in r.input).toBe(false)
  })

  it('trims the name and the task, and keeps a chosen model and effort', () => {
    const r = validate(
      good({ name: '  Nightly report ', task: ' /daily-report ', model: 'sonnet', effort: 'max' })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.input.name).toBe('Nightly report')
    expect(r.input.task).toBe('/daily-report')
    expect(r.input.model).toBe('sonnet')
    expect(r.input.effort).toBe('max')
  })

  it('keeps the lines of a task that spans several', () => {
    const r = validate(good({ task: 'first line\nsecond line' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.input.task).toBe('first line\nsecond line')
  })
})

describe('modelValue', () => {
  it('maps the chips to what the launch line carries', () => {
    expect(modelValue(f({ model: '' }))).toBeUndefined()
    expect(modelValue(f({ model: 'fable' }))).toBe('fable')
    expect(modelValue(f({ model: 'opus' }))).toBe('opus')
    expect(modelValue(f({ model: 'sonnet' }))).toBe('sonnet')
    expect(modelValue(f({ model: 'other', modelOther: '  claude-opus-5  ' }))).toBe('claude-opus-5')
  })
})

describe('suggest', () => {
  const skills: SkillSuggestion[] = [
    { name: '/zeta', description: 'Last one', source: 'project' },
    { name: '/beta', source: 'home' },
    { name: '/Zebra', source: 'home' }
  ]

  it('lists nothing until the text starts with a slash', () => {
    expect(suggest('', skills)).toEqual([])
    expect(suggest('write the report', skills)).toEqual([])
    expect(suggest('ze', skills)).toEqual([])
  })

  it('keeps the order it was given — project skills first, not alphabetical', () => {
    expect(suggest('/', skills).map((s) => s.name)).toEqual(['/zeta', '/beta', '/Zebra'])
  })

  it('matches the prefix without caring about case', () => {
    expect(suggest('/ze', skills).map((s) => s.name)).toEqual(['/zeta', '/Zebra'])
    expect(suggest('/ZE', skills).map((s) => s.name)).toEqual(['/zeta', '/Zebra'])
    expect(suggest('/zeta', skills).map((s) => s.name)).toEqual(['/zeta'])
  })

  it('closes itself once a picked name leaves its trailing space behind', () => {
    expect(suggest('/zeta ', skills)).toEqual([])
  })

  it('lists at most eight', () => {
    const many: SkillSuggestion[] = Array.from({ length: 12 }, (_, i) => ({
      name: `/s${i}`,
      source: 'home' as const
    }))
    expect(suggest('/s', many).map((s) => s.name)).toEqual([
      '/s0',
      '/s1',
      '/s2',
      '/s3',
      '/s4',
      '/s5',
      '/s6',
      '/s7'
    ])
  })
})

describe('history rows', () => {
  const NOW = new Date(2026, 8, 2, 12, 0, 0)
  const at = (h: number, m: number, dayOffset = 0): number =>
    new Date(2026, 8, 2 + dayOffset, h, m, 0, 0).getTime()

  it('names the outcome, and how many times when a row folded', () => {
    expect(histText({ dueAt: at(9, 0), state: 'closed' })).toBe('Closed by you')
    expect(histText({ dueAt: at(9, 0), state: 'ended' })).toBe('Ended — Koloft quit')
    expect(histText({ dueAt: at(9, 0), state: 'failed', note: 'no usable account' })).toBe(
      'Could not start — no usable account'
    )
    expect(histText({ dueAt: at(9, 0), state: 'missed' })).toBe(
      'Missed — Koloft was closed or asleep'
    )
    expect(histText({ dueAt: at(9, 0), state: 'missed', count: 85, until: at(10, 0) })).toBe(
      'Missed 85 times — Koloft was closed or asleep'
    )
    expect(histText({ dueAt: at(9, 0), state: 'skipped', count: 1 })).toBe(
      'Skipped — the last run was still open'
    )
    expect(histText({ dueAt: at(9, 0), state: 'skipped', count: 3, until: at(9, 30) })).toBe(
      'Skipped 3 times — the last run was still open'
    )
  })

  it('names both ends of a folded row, and one time for a plain one', () => {
    expect(histWhen({ dueAt: at(9, 0), state: 'missed' }, NOW)).toBe('today 09:00')
    expect(
      histWhen({ dueAt: at(20, 0, -1), state: 'missed', count: 85, until: at(10, 0) }, NOW)
    ).toBe('yesterday 20:00 → today 10:00')
    expect(histWhen({ dueAt: at(9, 0), state: 'skipped', count: 1, until: at(9, 0) }, NOW)).toBe(
      'today 09:00'
    )
  })

  it('ends where the row ends', () => {
    expect(histEnd({ dueAt: at(9, 0), state: 'closed' })).toBe(at(9, 0))
    expect(histEnd({ dueAt: at(20, 0, -1), state: 'missed', count: 85, until: at(10, 0) })).toBe(
      at(10, 0)
    )
  })
})

describe('forecastFor', () => {
  const NOW = new Date(2026, 8, 2, 12, 0, 0)
  const job = (name: string, at: string, over: Partial<CronJob> = {}): CronJob => ({
    id: `id-${name}`,
    workspacePath: '/ws-a',
    name,
    task: '/task',
    schedule: { kind: 'daily', at } as Schedule,
    permission: 'same',
    enabled: true,
    createdAt: 0,
    history: [],
    ...over
  })

  it('names the nearest switched-on job and counts the rest', () => {
    const f = forecastFor([job('Late', '21:00'), job('Soonest', '14:00')], '/ws-a', NOW)
    expect(f?.name).toBe('Soonest')
    expect(f?.id).toBe('id-Soonest')
    expect(f?.more).toBe(1)
    expect(f?.at.getHours()).toBe(14)
  })

  it('leaves out switched-off jobs and other workspaces', () => {
    const jobs = [
      job('Off', '13:00', { enabled: false }),
      job('Elsewhere', '13:30', { workspacePath: '/ws-b' }),
      job('Mine', '21:00')
    ]
    const f = forecastFor(jobs, '/ws-a', NOW)
    expect(f?.name).toBe('Mine')
    expect(f?.more).toBe(0)
  })

  it('says nothing at all when every job is switched off', () => {
    expect(forecastFor([job('Off', '13:00', { enabled: false })], '/ws-a', NOW)).toBeNull()
    expect(forecastFor([], '/ws-a', NOW)).toBeNull()
  })

  it('calls a run soon right up to the 60 minute mark', () => {
    expect(forecastFor([job('Edge', '13:00')], '/ws-a', NOW)?.soon).toBe(true)
    expect(forecastFor([job('Past', '13:01')], '/ws-a', NOW)?.soon).toBe(false)
  })

  it('lists every switched-on job in the hover text, nearest first', () => {
    const f = forecastFor([job('Late', '21:00'), job('Soonest', '14:00')], '/ws-a', NOW)
    expect(f?.title).toBe('Soonest · today 14:00\nLate · today 21:00\nScheduled jobs…')
  })
})

describe('a new job', () => {
  it('starts a Codex job on "Never ask", the way scheduled Codex runs have always run, and a Claude job on "Same as my other sessions"', () => {
    expect(emptyFields('codex').permission).toBe('skipAll')
    expect(emptyFields('claude').permission).toBe('same')
  })

  it('takes the other backend’s starting permission when switched before the permission was changed, and keeps a permission the user picked', () => {
    expect(permissionAfterSwitch(emptyFields('claude'), 'codex')).toBe('skipAll')
    expect(permissionAfterSwitch(emptyFields('codex'), 'claude')).toBe('same')
    expect(permissionAfterSwitch(f({ permission: 'acceptEdits' }), 'codex')).toBe('acceptEdits')
  })
})
