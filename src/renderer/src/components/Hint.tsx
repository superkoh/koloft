import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { popoverX } from '@shared/accountUsage'
import { HINT_IDS, type HintId } from '@shared/types'
import type { ActiveHint } from '../hints'
import { useStore } from '../store'
import { isSessionKind } from '../agentUi'
import { BACKEND_LABEL, capabilitiesFor } from '@shared/sessionBackend'
import { hostOf } from '@shared/remoteKey'

const CAPTURE_BEFORE_XTERM = true
const CARD_W = 268
const GAP = 10
const STILL_FRAMES = 10

function Pic(p: { h: number; label: string; children: JSX.Element }): JSX.Element {
  return (
    <svg className="pic" viewBox={`0 0 244 ${p.h}`} role="img" aria-label={p.label}>
      <rect
        x="0.5"
        y="0.5"
        width="243"
        height={p.h - 1}
        rx="6"
        fill="var(--bg-0)"
        stroke="var(--line)"
      />
      {p.children}
    </svg>
  )
}

interface HintWords {
  title: string
  body: JSX.Element
  pic: JSX.Element
}

interface AgentWords {
  name: string
  drivesBrowser: boolean
}

const CONTENT: Record<HintId, HintWords | ((agent: AgentWords) => HintWords)> = {
  workbench: ({ name }) => ({
    title: `${name} changed a file`,
    body: (
      <>
        It is in the <b>Workbench</b>, with a diff. Click here or press <b>⇧⌘B</b>.
      </>
    ),
    pic: (
      <Pic h={54} label="a diff, one line changed">
        <g>
          <rect x="1" y="9" width="242" height="17" fill="var(--red)" opacity="0.13" />
          <rect x="1" y="28" width="242" height="17" fill="var(--good)" opacity="0.15" />
          <text x="12" y="21" className="pt-mono" fill="var(--red)">
            − const port = 3000
          </text>
          <text x="12" y="40" className="pt-mono" fill="var(--good)">
            + const port = 8080
          </text>
        </g>
      </Pic>
    )
  }),
  approval: {
    title: 'Amber means a session needs you',
    body: (
      <>
        That session is waiting for your <b>OK</b>. Click the row to answer. When Koloft is in the
        background you get a notification as well.
      </>
    ),
    pic: (
      <Pic h={48} label="a session row with an amber bar">
        <g>
          <rect x="11" y="12" width="3" height="24" rx="1.5" fill="var(--amber)" />
          <text x="24" y="23" className="pt" fill="var(--fg)">
            Write tests
          </text>
          <text x="24" y="35" className="pt-sm" fill="var(--amber)">
            needs your OK
          </text>
        </g>
      </Pic>
    )
  },
  'agent-web': ({ name, drivesBrowser }) => ({
    title: `${name} opened this page here`,
    body: drivesBrowser ? (
      <>
        It is a <b>real browser</b> inside Koloft, and {name}&apos;s Playwright tools can drive it.
        Turn that off in Settings ▸ Extensions.
      </>
    ) : (
      <>
        It is a <b>real browser</b> inside Koloft.
      </>
    ),
    pic: (
      <Pic h={44} label="a browser address bar">
        <g>
          <rect
            x="11.5"
            y="12.5"
            width="221"
            height="19"
            rx="9.5"
            fill="var(--bg-2)"
            stroke="var(--line)"
          />
          <g fill="none" stroke="var(--fg-faint)" strokeWidth="1">
            <circle cx="26" cy="22" r="4.5" />
            <path d="M21.5 22 h9" />
            <path d="M26 17.5 c2.4 2.7 2.4 6.3 0 9 c-2.4 -2.7 -2.4 -6.3 0 -9" />
          </g>
          <text x="38" y="25" className="pt-mono" fill="var(--fg-dim)">
            example.com/docs
          </text>
        </g>
      </Pic>
    )
  }),
  worktree: {
    title: 'Two sessions on one folder?',
    body: (
      <>
        They can step on each other&apos;s files. <b>⇧⌘N</b> starts the new one in its own git
        worktree, so each works on a copy.
      </>
    ),
    pic: (
      <Pic h={66} label="one folder, two sessions">
        <g>
          <path
            d="M16 20 h12 l4 5 h16 a3 3 0 0 1 3 3 v13 a3 3 0 0 1 -3 3 H16 a3 3 0 0 1 -3 -3 V23z"
            fill="var(--folder)"
            opacity="0.85"
          />
          <text x="34" y="57" className="pt-mono" textAnchor="middle" fill="var(--fg-dim)">
            my-app/
          </text>
          <g stroke="var(--fg-faint)" strokeWidth="1.1" fill="none">
            <path d="M56 33 h16" />
            <path d="M67 29 l5 4 -5 4" />
          </g>
          <rect x="80" y="12" width="3" height="18" rx="1.5" fill="var(--accent)" />
          <text x="92" y="24" className="pt" fill="var(--fg)">
            Fix login bug
          </text>
          <rect x="80" y="38" width="3" height="18" rx="1.5" fill="var(--accent)" />
          <text x="92" y="50" className="pt" fill="var(--fg)">
            Add tests
          </text>
        </g>
      </Pic>
    )
  },
  github: {
    title: 'This project is on GitHub',
    body: (
      <>
        The number is this branch&apos;s <b>pull request</b>. Click to read it here;
        <b> right-click</b> for the repository and the pull-request list.
      </>
    ),
    pic: (
      <Pic h={44} label="the tab strip's GitHub button">
        <g>
          <rect x="11.5" y="12.5" width="60" height="19" rx="6" fill="none" stroke="var(--line)" />
          <text x="28" y="25" className="pt" fill="var(--fg-dim)">
            Files
          </text>
          <rect x="78" y="12.5" width="52" height="19" rx="6" fill="var(--bg-3)" />
          <circle cx="90" cy="22" r="6" fill="var(--fg-dim)" />
          <text x="101" y="25" className="pt-mono" fill="var(--fg)">
            #265
          </text>
          <path d="M140 13 v18" stroke="var(--line-2)" strokeWidth="1" />
        </g>
      </Pic>
    )
  }
}

function place(r: DOMRect, cardH: number): { left: number; top: number } {
  const vh = window.innerHeight
  const below = r.bottom + GAP
  const wanted = below + cardH <= vh - GAP ? below : r.top - GAP - cardH
  return {
    left: popoverX(r.left + r.width / 2, CARD_W, window.innerWidth, GAP),
    top: Math.min(Math.max(GAP, wanted), vh - cardH - GAP)
  }
}

type Box = { rect: DOMRect; left: number; top: number }

function sameBox(b: Box, rect: DOMRect, pos: { left: number; top: number }): boolean {
  return (
    b.left === pos.left &&
    b.top === pos.top &&
    b.rect.left === rect.left &&
    b.rect.top === rect.top &&
    b.rect.width === rect.width &&
    b.rect.height === rect.height
  )
}

export function Hint({ id, selector, n, onDone, onOff }: ActiveHint): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const cardH = useRef(0)
  const boxRef = useRef<Box | null>(null)
  const [box, setBox] = useState<Box | null>(null)

  const measure = useCallback((): boolean => {
    const el = document.querySelector(selector)
    if (!el) {
      if (!boxRef.current) return true
      boxRef.current = null
      setBox(null)
      return false
    }
    if (!cardH.current) cardH.current = cardRef.current?.offsetHeight ?? 0
    const rect = el.getBoundingClientRect()
    const pos = place(rect, cardH.current)
    if (boxRef.current && sameBox(boxRef.current, rect, pos)) return true
    boxRef.current = { rect, ...pos }
    setBox(boxRef.current)
    return false
  }, [selector])

  useLayoutEffect(() => {
    let raf = 0
    let still = 0
    const tick = (): void => {
      still = measure() ? still + 1 : 0
      raf = still >= STILL_FRAMES ? 0 : requestAnimationFrame(tick)
    }
    const burst = (): void => {
      still = measure() ? 1 : 0
      if (!raf) raf = requestAnimationFrame(tick)
    }
    burst()
    const mo = new MutationObserver(burst)
    for (const root of ['.side', '.wb-tabs']) {
      const el = document.querySelector(root)
      if (el) mo.observe(el, { childList: true, subtree: true, attributes: true })
    }
    window.addEventListener('resize', burst)
    window.addEventListener('scroll', burst, true)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      mo.disconnect()
      window.removeEventListener('resize', burst)
      window.removeEventListener('scroll', burst, true)
    }
  }, [measure])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDone()
    }
    const onDown = (e: MouseEvent): void => {
      if (!cardRef.current?.contains(e.target as Node)) onDone()
    }
    window.addEventListener('keydown', onKey, CAPTURE_BEFORE_XTERM)
    window.addEventListener('mousedown', onDown, CAPTURE_BEFORE_XTERM)
    return () => {
      window.removeEventListener('keydown', onKey, CAPTURE_BEFORE_XTERM)
      window.removeEventListener('mousedown', onDown, CAPTURE_BEFORE_XTERM)
    }
  }, [onDone])

  const session = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const content = CONTENT[id]
  const { title, body, pic } =
    typeof content === 'function'
      ? content(
          session && isSessionKind(session.kind)
            ? {
                name: BACKEND_LABEL[session.kind],
                drivesBrowser:
                  capabilitiesFor(session.kind, hostOf(session.cwd)).browserControl === true
              }
            : { name: 'The session', drivesBrowser: false }
        )
      : content
  // ADR-0013
  return createPortal(
    <>
      {box && (
        <div
          className="hint-backdrop"
          style={{
            left: box.rect.left - 4,
            top: box.rect.top - 4,
            width: box.rect.width + 8,
            height: box.rect.height + 8
          }}
        />
      )}
      <div
        ref={cardRef}
        className="hint-card"
        data-hint={id}
        tabIndex={-1}
        role="dialog"
        aria-label={title}
        style={{
          left: box?.left ?? -9999,
          top: box?.top ?? -9999,
          visibility: box ? 'visible' : 'hidden'
        }}
      >
        <div className="h">{title}</div>
        <div className="t">{body}</div>
        {pic}
        <div className="foot">
          <span className="n">{`tip ${n} of ${HINT_IDS.length}`}</span>
          <button className="ob-link" onMouseDown={(e) => e.preventDefault()} onClick={onOff}>
            Don&apos;t show tips
          </button>
          <button className="mini" onMouseDown={(e) => e.preventDefault()} onClick={onDone}>
            Got it
          </button>
        </div>
      </div>
    </>,
    document.body
  )
}
