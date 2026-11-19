import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { SecretAskView } from '@shared/types'
import { IconClose, IconLock, IconSignIn, IconWebPage } from '@renderer/icons'
import { isComposing } from '@renderer/keys'
import type { OverTerminal, PageAsk } from '@renderer/slots'
import { useSecretAsks } from './state'

type SudoAsk = Extract<SecretAskView, { kind: 'sudo' }>
type WebAsk = Exclude<SecretAskView, { kind: 'sudo' }>

function sudoAskOf(asks: readonly SecretAskView[], tabId: string): SudoAsk | undefined {
  return asks.find((a): a is SudoAsk => a.tabId === tabId && a.kind === 'sudo')
}

function webAskOf(asks: readonly SecretAskView[], tabId: string | null): WebAsk | undefined {
  return asks.find((a): a is WebAsk => a.tabId === tabId && a.kind !== 'sudo')
}

export const useAsked = (): readonly SecretAskView[] => useSecretAsks((s) => s.asks)

export function useSudoOverTerminal(): (tabId: string) => OverTerminal | undefined {
  const asks = useAsked()
  return (tabId) => {
    const ask = sudoAskOf(asks, tabId)
    return ask && ((shown) => <SudoDialog key={ask.id} ask={ask} shown={shown} />)
  }
}

export function usePageAsk(ownerTab: string | null): PageAsk | undefined {
  const ask = useSecretAsks((s) => webAskOf(s.asks, ownerTab))
  return (
    ask && {
      id: ask.id,
      guestId: ask.kind === 'url' ? undefined : ask.guestId,
      bar: <SecretPageBar ask={ask} />
    }
  )
}

export const useTappedGuests = (): readonly number[] =>
  useSecretAsks(useShallow((s) => s.asks.flatMap((a) => (a.kind === 'tap' ? [a.guestId] : []))))

export function SudoDialog({ ask, shown }: { ask: SudoAsk; shown: boolean }): JSX.Element {
  const [value, setValue] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (shown) input.current?.focus()
  }, [shown, ask.id])
  const decline = (): void => window.api.secret.decline(ask.id)
  const passOn = (): void => {
    if (value) window.api.secret.answer(ask.id, value)
  }
  return (
    <div className="modal-backdrop in-session">
      <div className="modal secret-modal" role="dialog" aria-label="Sudo password">
        <div className="modal-header">
          <span>Sudo password</span>
          <span className="modal-close" onClick={decline} aria-label="Close">
            <IconClose size={16} />
          </span>
        </div>
        <div className="modal-body">
          <p className="field-hint">
            This session runs <code>{ask.command}</code>, and sudo asks:{' '}
            <code>{ask.prompt || 'Password:'}</code>
          </p>
          <span className="flabel">Your sudo password</span>
          <div className="cb-input focus">
            <input
              ref={input}
              className="cb-field"
              type="password"
              aria-label="Your sudo password"
              spellCheck={false}
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isComposing(e)) {
                  e.preventDefault()
                  passOn()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  decline()
                }
              }}
            />
          </div>
          <p className="field-hint">Koloft types it into sudo itself: the session never sees it.</p>
        </div>
        <div className="modal-foot">
          <button className="mini" onClick={decline}>
            Cancel
          </button>
          <button className="btn-primary" data-default="true" disabled={!value} onClick={passOn}>
            Pass on<span className="k">⏎</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export function SecretPageBar({ ask }: { ask: WebAsk }): JSX.Element {
  return (
    <div className="bperm" role="alertdialog" aria-label="Secret ask">
      <span className="bperm-ico">
        {ask.kind === 'page' ? (
          <IconLock size={16} />
        ) : ask.kind === 'tap' ? (
          <IconWebPage size={16} />
        ) : (
          <IconSignIn size={16} />
        )}
      </span>
      <span className="bperm-msg" title={ask.kind === 'tap' ? ask.label : undefined}>
        {ask.kind === 'page' ? (
          <>
            This session needs your <b>{ask.label}</b> on this page.
          </>
        ) : ask.kind === 'tap' ? (
          <>
            This session needs you to click on this page: <b>{ask.label}</b>
          </>
        ) : (
          'This session needs you to finish this sign-in here.'
        )}
      </span>
      <span className="bperm-btns">
        <button className="bperm-b" onClick={() => window.api.secret.decline(ask.id)}>
          Cancel
        </button>
        {ask.kind !== 'url' && (
          <button className="bperm-b pri" onClick={() => window.api.secret.done(ask.id)}>
            Done
          </button>
        )}
      </span>
    </div>
  )
}
