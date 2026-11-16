import { useState, type InputHTMLAttributes, type JSX } from 'react'
import type { NamedModel } from '@shared/cronModels'
import { CRON_EFFORTS, type CronEffort } from '@shared/types'

export const OTHER_MODEL = 'other'

const EFFORT_LABEL: Record<CronEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

export function effortLabel(effort: CronEffort): string {
  return EFFORT_LABEL[effort]
}

export function useFieldFocus(): {
  inputCls(key: string): string
  focusProps(key: string): { onFocus: () => void; onBlur: () => void }
} {
  const [focused, setFocused] = useState('')
  return {
    inputCls: (key) => 'cb-input' + (focused === key ? ' focus' : ''),
    focusProps: (key) => ({
      onFocus: () => setFocused(key),
      onBlur: () => setFocused((k) => (k === key ? '' : k))
    })
  }
}

export function ModelAndThinking(p: {
  models: readonly NamedModel[]
  model: string
  modelOther: string
  unsetModel: string
  onModel(model: string): void
  onModelOther(text: string): void
  otherInput: { className: string } & InputHTMLAttributes<HTMLInputElement>
  modelHint?: string
  modelError?: string
  efforts: readonly CronEffort[]
  effort: CronEffort | ''
  unsetEffort: string
  onEffort(effort: CronEffort | ''): void
  effortHint: string
}): JSX.Element {
  const modelChips = [
    { value: '', label: p.unsetModel },
    ...p.models.map((m) => ({ value: m.id, label: m.label })),
    { value: OTHER_MODEL, label: 'Other…' }
  ]
  const effortChips: { value: CronEffort | ''; label: string }[] = [
    { value: '', label: p.unsetEffort },
    ...CRON_EFFORTS.filter((e) => p.efforts.includes(e)).map((e) => ({
      value: e,
      label: EFFORT_LABEL[e]
    }))
  ]
  const { className: otherClass, ...otherProps } = p.otherInput
  return (
    <>
      <span className="flabel">Model</span>
      <div className="fcol">
        <div className="chips">
          {modelChips.map((c) => (
            <button
              key={c.label}
              className={'chip' + (p.model === c.value ? ' on' : '')}
              onClick={() => p.onModel(c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
        {p.model === OTHER_MODEL && (
          <div className={otherClass}>
            <input
              className="cb-field"
              aria-label="Model name"
              spellCheck={false}
              autoComplete="off"
              value={p.modelOther}
              onChange={(e) => p.onModelOther(e.target.value)}
              {...otherProps}
            />
          </div>
        )}
        {p.modelHint && <p className="field-hint">{p.modelHint}</p>}
        {p.modelError && <p className="field-hint bad">{p.modelError}</p>}
      </div>

      <span className="flabel">Thinking</span>
      <div className="fcol">
        <div className="chips">
          {effortChips.map((c) => (
            <button
              key={c.label}
              className={'chip' + (p.effort === c.value ? ' on' : '')}
              onClick={() => p.onEffort(c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <p className="field-hint">{p.effortHint}</p>
      </div>
    </>
  )
}
