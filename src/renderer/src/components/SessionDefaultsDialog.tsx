import { useEffect, useLayoutEffect, useState, type JSX } from 'react'
import { IconClose } from '../icons'
import type { BackendId, CronEffort, OwnPick, SessionDefaults } from '@shared/types'
import { basename } from '@shared/preview'
import { BACKEND_LABEL, SESSION_BACKENDS, byBackend, kindsOf } from '@shared/sessionBackend'
import { effortsFor } from '@shared/cronModels'
import { isValidModelName } from '@shared/cronNames'
import { ownPickOf, tiersOf } from '@shared/sessionPicks'
import { ownPickModels } from '@shared/sessionDefaults'
import { modelValue } from '../cronForm'
import { useStore } from '../store'
import { ModelAndThinking, OTHER_MODEL, effortLabel, useFieldFocus } from './ModelAndThinking'
import '../cronJobs.css'

interface PickFields {
  model: string
  modelOther: string
  effort: CronEffort | ''
}

const NOT_SET: PickFields = { model: '', modelOther: '', effort: '' }

const INTRO =
  'A session you start in this workspace yourself — the + button, ⌘N, ⌘P — starts on this model and thinking. Pick an agent to set its own.'
const RULES_HINT =
  "How an agent in this workspace picks the model and thinking for a session it starts with koloft session new. Left empty, agents sort the task as very simple, normal or very hard and use Koloft's own pick for each."
const RULES_PLACEHOLDER = `Left empty, an agent sorts the task and uses Koloft's own pick:\n${SESSION_BACKENDS.map(tiersOf).join('\n')}`
const BAD_MODEL = 'A model name is letters, digits, dots, colons, dashes or underscores.'

const modelHint = (label: string): string => `Default = the model ${label} itself starts on.`
const effortHint = (label: string): string =>
  `How hard ${label} thinks before it answers. Same as usual = what ${label} itself uses.`

function fieldsOf(backend: BackendId, pick: OwnPick | undefined): PickFields {
  const model = pick?.model
  const named = ownPickModels(backend).some((m) => m.id === model)
  return {
    model: !model ? '' : named ? model : OTHER_MODEL,
    modelOther: model && !named ? model : '',
    effort: pick?.effort ?? ''
  }
}

const modelOf = (f: PickFields): string | undefined => modelValue(f) || undefined

export function SessionDefaultsDialog({
  wsPath,
  onClose
}: {
  wsPath: string
  onClose: () => void
}): JSX.Element {
  const enabled = useStore((s) => s.settings.sessionMethods.enabled)
  const backends = SESSION_BACKENDS.filter((b) => enabled[b])
  const [familyEfforts, setFamilyEfforts] = useState<Record<string, CronEffort[]> | null>(null)
  const [error, setError] = useState('')
  const [picks, setPicks] = useState<Record<BackendId, PickFields>>(() => byBackend(() => NOT_SET))
  const [rules, setRules] = useState('')
  const [shown, setShown] = useState<BackendId>(backends[0] ?? 'claude')
  const { inputCls, focusProps } = useFieldFocus()

  useEffect(() => {
    let live = true
    void window.api.sessionDefaults.read(wsPath).then(
      (r) => {
        if (!live) return
        if (!r.ok) return setError(r.error)
        setPicks(byBackend((b) => fieldsOf(b, r.defaults.picks[b])))
        setRules(r.defaults.rules ?? '')
        setFamilyEfforts(r.familyEfforts)
      },
      (e: unknown) => live && setError(String(e))
    )
    return () => {
      live = false
    }
  }, [wsPath])

  // PLATFORM§25
  useLayoutEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const effortsOf = (b: BackendId, m: string | undefined): readonly CronEffort[] =>
    (b === 'agy' && m && familyEfforts?.[m]) || effortsFor(b, m)
  const pickOf = (b: BackendId): OwnPick | undefined => {
    const m = modelOf(picks[b])
    const e = picks[b].effort
    const typed = picks[b].model === OTHER_MODEL
    return ownPickOf(m, e && (typed || effortsOf(b, m).includes(e)) ? e : undefined)
  }
  const picked = backends.map((b) => ({ b, pick: pickOf(b) }))

  const fields = picks[shown]
  const label = BACKEND_LABEL[shown]
  const patch = (p: Partial<PickFields>): void =>
    setPicks((all) => ({ ...all, [shown]: { ...all[shown], ...p } }))

  const badModel = backends.find((b) => {
    const f = picks[b]
    return f.model === OTHER_MODEL && !isValidModelName(f.modelOther.trim())
  })

  const summary = (): string => {
    const set = picked.flatMap(({ b, pick }) => {
      if (!pick) return []
      const name = ownPickModels(b).find((m) => m.id === pick.model)?.label ?? pick.model
      return [
        [BACKEND_LABEL[b], name, pick.effort && effortLabel(pick.effort)]
          .filter(Boolean)
          .join(' · ')
      ]
    })
    const unset = picked.filter(({ pick }) => !pick).map(({ b }) => b)
    if (!set.length) return 'Set now: nothing. Every agent starts as it does today.'
    const rest =
      unset.length === 0
        ? ''
        : ` ${kindsOf(unset, 'and')} ${unset.length === 1 ? 'starts as it does' : 'start as they do'} today.`
    return `Set now: ${set.join('; ')}.${rest}`
  }

  const save = async (): Promise<void> => {
    const out: SessionDefaults = {
      picks: Object.fromEntries(
        SESSION_BACKENDS.flatMap((b) => {
          const pick = pickOf(b)
          return pick ? [[b, pick]] : []
        })
      ),
      ...(rules.trim() && { rules: rules.trim() })
    }
    const r = await window.api.sessionDefaults.write(wsPath, out)
    if (r.ok) onClose()
    else setError(r.error ?? 'Koloft could not save these.')
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal cronjobs"
        role="dialog"
        aria-label="Session defaults"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>{`Session defaults · ${basename(wsPath)}`}</span>
          <span className="modal-close" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </span>
        </div>
        <div className="modal-body">
          {error && <p className="field-hint bad">{error}</p>}
          {familyEfforts && (
            <div className="fgrid">
              <span className="flabel">When you start one</span>
              <div className="fcol">
                <p className="fnote">{INTRO}</p>
                {backends.length > 1 && (
                  <div className="chips">
                    {backends.map((b) => (
                      <button
                        key={b}
                        className={'chip' + (shown === b ? ' on' : '')}
                        onClick={() => setShown(b)}
                      >
                        {BACKEND_LABEL[b]}
                      </button>
                    ))}
                  </div>
                )}
                <p className="field-hint">{summary()}</p>
              </div>

              <ModelAndThinking
                models={ownPickModels(shown)}
                model={fields.model}
                modelOther={fields.modelOther}
                unsetModel="Default"
                onModel={(m) => patch({ model: m })}
                onModelOther={(modelOther) => patch({ modelOther })}
                otherInput={{ className: inputCls('modelOther'), ...focusProps('modelOther') }}
                modelHint={modelHint(label)}
                modelError={badModel === shown ? BAD_MODEL : undefined}
                efforts={effortsOf(shown, modelOf(fields))}
                effort={pickOf(shown)?.effort ?? ''}
                unsetEffort="Same as usual"
                onEffort={(e) => patch({ effort: e })}
                effortHint={effortHint(label)}
              />

              <span className="flabel">When an agent starts one</span>
              <div className="fcol">
                <div className={inputCls('rules')}>
                  <textarea
                    className="cb-field task"
                    aria-label="How agents pick"
                    rows={6}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={RULES_PLACEHOLDER}
                    value={rules}
                    onChange={(e) => setRules(e.target.value)}
                    {...focusProps('rules')}
                  />
                </div>
                <p className="field-hint">{RULES_HINT}</p>
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span style={{ flex: 1 }} />
          <button className="mini" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!familyEfforts || !!badModel}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
