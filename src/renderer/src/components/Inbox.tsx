import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import {
  INBOX_LEVELS,
  answersComplete,
  cardsIn,
  facetsOf,
  inboxCounts,
  levelOf,
  pickToPress,
  visibleActions,
  whereKeys,
  type ChoiceAnswer,
  type InboxAction,
  type InboxAnswers,
  type InboxBlock,
  type InboxCard,
  type InboxCounts,
  type InboxLevel,
  type InboxLink,
  type InboxSort,
  type InboxState
} from '@shared/inbox'
import { useStore } from '../store'
import { IconInbox } from '../icons'
import { isComposing } from '../keys'
import { everyWorkspaceRows } from '../butlerRows'
import { openSessionRow, visitTab } from '../sessionClick'
import { relTime } from '../sessionRows'
import { useDismissOnOutside } from './WorkspaceSidebar'
import '../inbox.css'

const TAB_NAME: Record<InboxState, string> = {
  'needs-you': 'Needs you',
  'in-progress': 'In progress',
  closed: 'Done'
}
const LEVEL_NAME: Record<InboxLevel, string> = { high: 'High', normal: 'Normal', low: 'Low' }
const OUTCOME = {
  done: ['✓', 'Done'],
  failed: ['✕', 'Failed'],
  elsewhere: ['→', 'Done elsewhere']
} as const
const SORTS: [InboxSort, string, string][] = [
  ['priority', 'Priority', 'High first, then oldest first'],
  ['newest', 'Newest', 'Newest first'],
  ['oldest', 'Oldest', 'Oldest first']
]
const COUNTDOWN_TICK_MS = 250
const CLOCK_TICK_MS = 60_000
const FLY_MS = 620
const SLIDE_MS = 380
const MOST_BUTTONS_IN_A_ROW = 3
const ONE_TURN_MS = 6000

type Menu =
  | { kind: 'level'; card: string }
  | { kind: 'more'; card: string }
  | { kind: 'filter'; name: string }
  | null

function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function lede(needs: number, high: number, working: number): string {
  const busy = working
    ? ` ${working} session${working > 1 ? 's are' : ' is'} working — ${working > 1 ? 'they' : 'it'} won’t bother you.`
    : ''
  if (!needs) return `Nothing needs you right now.${busy}`
  return `${needs} thing${needs > 1 ? 's need' : ' needs'} you${high ? `, ${high} of them high` : ''}.${busy}`
}

function secondsLeft(until: number | undefined, now: number): number {
  return Math.max(0, Math.ceil(((until ?? now) - now) / 1000))
}

function ordered(
  card: InboxCard,
  acts: InboxAction[]
): { out: InboxAction[]; more: InboxAction[] } {
  const rec = card.suggestion?.action
  const all = [
    ...acts.filter((a) => a.style === 'main'),
    ...acts.filter((a) => a.id === rec && a.style !== 'main'),
    ...acts.filter((a) => a.style !== 'main' && a.id !== rec && a.style !== 'danger'),
    ...acts.filter((a) => a.style === 'danger' && a.id !== rec)
  ]
  if (!all.some((a) => a.style === 'danger') && all.length <= MOST_BUTTONS_IN_A_ROW)
    return { out: all, more: [] }
  const safe = all.filter((a) => a.style !== 'danger')
  return {
    out: safe.slice(0, 2),
    more: [...safe.slice(2), ...all.filter((a) => a.style === 'danger')]
  }
}

function openSessionRef(ref: string): void {
  const st = useStore.getState()
  st.setInboxOpen(false)
  if (st.tabs.some((t) => t.id === ref)) return visitTab(ref)
  const live = st.sessions.find((s) => s.sessionId === ref && s.alive && s.tabId)
  if (live?.tabId) return visitTab(live.tabId)
  for (const ws of everyWorkspaceRows(st)) {
    const row = ws.rows.find((r) => r.id === ref)
    if (row) return openSessionRow(row, ws.workspace.path)
  }
  st.showToast('That session is not in the sidebar any more.')
}

function openLink(l: InboxLink): void {
  if (l.to.type === 'browser') window.api.browser.openExternal(l.to.url)
  else openSessionRef(l.to.session)
}

function byText(card: InboxCard): string {
  const h = card.history[0]
  if (!h) return ''
  const pressed = card.actions.find((a) => a.id === h.by)
  const who =
    h.by === 'inbox'
      ? 'by the Inbox'
      : h.by === 'you'
        ? 'you dismissed it'
        : pressed
          ? `you pressed “${pressed.label}”`
          : `by ${card.sourceName}`
  return h.why ? `${who} · ${h.why}` : who
}

function tagOf(card: InboxCard): string {
  return [card.sourceName, ...Object.values(card.where)].join(' · ')
}

function waitingLine({ badge, high, byState }: InboxCounts): string {
  const low = byState['needs-you'] - badge
  if (!badge) return low ? `${low} low, no rush` : 'Nothing needs you'
  const line = `${badge} need${badge === 1 ? 's' : ''} you`
  return high ? `${line} · ${high} high` : line
}

function lastArrival(cards: InboxCard[]): number {
  let at = 0
  for (const c of cards)
    if (c.state === 'needs-you' && levelOf(c) !== 'low') at = Math.max(at, c.stateSince)
  return at
}

export function InboxRow(): JSX.Element {
  const open = useStore((s) => s.inboxOpen)
  const cards = useStore((s) => s.inbox.cards)
  const c = inboxCounts(cards, Date.now())
  const entry = useRef<HTMLDivElement>(null)
  const turn = useRef<Animation>(undefined)
  const arrivedUpTo = useRef(Date.now())
  const arrival = lastArrival(cards)
  useEffect(() => {
    if (arrival <= arrivedUpTo.current) return
    arrivedUpTo.current = arrival
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    turn.current?.cancel()
    turn.current = entry.current?.animate(
      [{ '--ibx-a': '0deg' }, { '--ibx-a': '360deg' }],
      ONE_TURN_MS
    )
  }, [arrival])
  return (
    <div className="ibx-entry-wrap">
      <div
        ref={entry}
        className={'ibx-entry' + (c.badge > 0 ? ' lit' : '') + (open ? ' on' : '')}
        onClick={() => useStore.getState().setInboxOpen(true)}
      >
        <svg className="ibx-ink-defs" aria-hidden>
          <linearGradient id="ibx-ink" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--accent)" />
            <stop offset="1" stopColor="var(--fable)" />
          </linearGradient>
        </svg>
        <span className="ibx-entry-icon">
          <IconInbox size={18} fill="url(#ibx-ink)" />
        </span>
        <span className="ibx-entry-text">
          <span className="ibx-entry-name">Inbox</span>
          <span className="ws-tab-sub">
            <span>{waitingLine(c)}</span>
          </span>
        </span>
        {c.badge > 0 && <span className={'ibx-count' + (c.high ? ' high' : '')}>{c.badge}</span>}
      </div>
    </div>
  )
}

export function InboxPage(): JSX.Element {
  const snapshot = useStore((s) => s.inbox)
  const sessions = useStore((s) => s.sessions)
  const [tab, setTab] = useState<InboxState>('needs-you')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<InboxSort>('priority')
  const [menu, setMenu] = useState<Menu>(null)
  const [answers, setAnswers] = useState<Record<string, InboxAnswers>>({})
  const [openId, setOpenId] = useState<Record<string, string | undefined>>({})
  const [now, setNow] = useState(Date.now())
  const page = useRef<HTMLDivElement>(null)
  const seen = useRef(new Map<string, { rect: DOMRect; el: HTMLElement; tab: InboxState }>())

  const ready = new Set(snapshot.ready)
  const waiting = snapshot.cards.some((c) => c.press?.step === 'waiting')
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), waiting ? COUNTDOWN_TICK_MS : CLOCK_TICK_MS)
    return () => clearInterval(t)
  }, [waiting])

  useDismissOnOutside(!!menu, setMenu)

  const minute = Math.floor(now / CLOCK_TICK_MS)
  const { counts, facets, list, keys } = useMemo(() => {
    const at = minute * CLOCK_TICK_MS
    const { source, ...where } = filters
    return {
      counts: inboxCounts(snapshot.cards, at),
      facets: facetsOf(snapshot.cards, tab, at),
      list: cardsIn(snapshot.cards, tab, { source, where, sort }, at),
      keys: whereKeys(snapshot.cards)
    }
  }, [snapshot.cards, tab, filters, sort, minute])
  const picked = list.find((c) => c.id === openId[tab]) ?? list[0]

  useLayoutEffect(() => {
    const root = page.current
    if (!root) return
    const before = seen.current
    const after = new Map<string, { rect: DOMRect; el: HTMLElement; tab: InboxState }>()
    for (const el of root.querySelectorAll<HTMLElement>('[data-cid]')) {
      const id = el.dataset.cid as string
      const rect = el.getBoundingClientRect()
      after.set(id, { rect, el, tab })
      const old = before.get(id)
      const dy = old && old.tab === tab ? old.rect.top - rect.top : 0
      if (Math.abs(dy) >= 1)
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
          duration: SLIDE_MS,
          easing: 'cubic-bezier(.2,.8,.2,1)'
        })
    }
    for (const [id, old] of before) {
      if (after.has(id) || old.tab !== tab) continue
      const card = snapshot.cards.find((c) => c.id === id)
      const target = card && root.querySelector(`.ibx-seg [data-tab="${card.state}"]`)
      if (!card || card.state === tab || !target) continue
      flyTo(old.rect, old.el.cloneNode(true) as HTMLElement, target.getBoundingClientRect())
    }
    seen.current = after
  }, [snapshot, tab, filters, sort, openId])

  const answersOf = (id: string): InboxAnswers => answers[id] ?? {}
  const setAnswer = (cardId: string, block: string, value: ChoiceAnswer | string): void =>
    setAnswers((a) => ({ ...a, [cardId]: { ...a[cardId], [block]: value } }))

  const press = (card: InboxCard, action: InboxAction, given = answersOf(card.id)): void => {
    setMenu(null)
    setOpenId((o) => ({ ...o, [tab]: card.id }))
    window.api.inbox.press(card.id, action.id, given)
  }

  const pick = (
    card: InboxCard,
    block: string,
    q: string,
    option: string,
    multi: boolean
  ): void => {
    const given = answersOf(card.id)
    const cur = (given[block] as ChoiceAnswer | undefined) ?? {}
    const was = Array.isArray(cur[q]) ? (cur[q] as string[]) : []
    const next: ChoiceAnswer = {
      ...cur,
      [q]: multi
        ? was.includes(option)
          ? was.filter((x) => x !== option)
          : [...was, option]
        : [option]
    }
    setAnswer(card.id, block, next)
    const auto = pickToPress(card)
    if (auto && auto.block === block) press(card, auto.action, { ...given, [block]: next })
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || tab === 'closed' || !picked) return
    const i = list.indexOf(picked)
    if (e.key === 'ArrowDown' && list[i + 1]) setOpenId((o) => ({ ...o, [tab]: list[i + 1].id }))
    else if (e.key === 'ArrowUp' && list[i - 1]) setOpenId((o) => ({ ...o, [tab]: list[i - 1].id }))
    else if (['1', '2', '3'].includes(e.key) && !picked.press && ready.has(picked.source)) {
      const n = Number(e.key) - 1
      const auto = pickToPress(picked)
      if (auto) {
        const o = auto.question.options[n]
        if (o) pick(picked, auto.block, auto.question.id, o.id, false)
      } else {
        const { out } = ordered(picked, visibleActions(picked))
        const a = out[n]
        if (a && answersComplete(picked, a, answersOf(picked.id))) press(picked, a)
      }
    } else return
    e.preventDefault()
  }

  const working = sessions.filter((s) => s.alive && s.status === 'working').length

  const filterPill = (name: string, label: string): JSX.Element => {
    const opts = facets[name] ?? []
    const v = filters[name]
    const open = menu?.kind === 'filter' && menu.name === name
    const set = (value: string | undefined): void => {
      setFilters((f) => {
        const { [name]: _drop, ...rest } = f
        return value ? { ...rest, [name]: value } : rest
      })
      setMenu(null)
    }
    return (
      <span className="ibx-fwrap" key={name} onClick={(e) => e.stopPropagation()}>
        <button
          className={'ibx-pill' + (v ? ' on' : '') + (open ? ' open' : '')}
          onClick={() => setMenu(open ? null : { kind: 'filter', name })}
        >
          <span className="fk">{label}</span>
          <span className="fv">{opts.find((o) => o.value === v)?.label ?? (v ? '—' : 'All')}</span>
          {v ? (
            <span
              className="fx"
              onClick={(e) => {
                e.stopPropagation()
                set(undefined)
              }}
            >
              ×
            </span>
          ) : (
            <span className="fcaret" />
          )}
        </button>
        {open && (
          <div className="ibx-pop">
            <div className={'ibx-opt' + (v ? '' : ' cur')} onClick={() => set(undefined)}>
              <span>All</span>
              <b>{opts.reduce((n, o) => n + o.n, 0)}</b>
            </div>
            {opts.map((o) => (
              <div
                key={o.value}
                className={'ibx-opt' + (o.value === v ? ' cur' : '')}
                onClick={() => set(o.value)}
              >
                <span>{o.label}</span>
                <b>{o.n}</b>
              </div>
            ))}
          </div>
        )}
      </span>
    )
  }

  const sortOpen = menu?.kind === 'filter' && menu.name === 'sort'

  return (
    <div className="inbox-page" ref={page} tabIndex={-1} onKeyDown={onKey}>
      <div className="ibx-col">
        <div className="ibx-top">
          <span className="ibx-orb">
            <span />
          </span>
          <div>
            <div className="ibx-hello">{greeting(new Date(now).getHours())}</div>
            <p className="ibx-lede">{lede(counts.byState['needs-you'], counts.high, working)}</p>
          </div>
        </div>
        <div className="ibx-tools">
          <div className="ibx-seg">
            {(Object.keys(TAB_NAME) as InboxState[]).map((t) => (
              <button
                key={t}
                className={tab === t ? 'on' : ''}
                data-tab={t}
                onClick={() => {
                  setTab(t)
                  setFilters({})
                  setMenu(null)
                  window.api.inbox.clearNotes()
                }}
              >
                {TAB_NAME[t]}
                <b>{counts.byState[t]}</b>
              </button>
            ))}
          </div>
          <div className="ibx-fbar">
            {Object.values(filters).some(Boolean) && (
              <button className="ibx-clearall" onClick={() => setFilters({})}>
                Clear all
              </button>
            )}
            <span className="ibx-fwrap" onClick={(e) => e.stopPropagation()}>
              <button
                className={
                  'ibx-pill' + (tab === 'closed' ? ' dis' : '') + (sortOpen ? ' open' : '')
                }
                title={tab === 'closed' ? 'Done is always newest first' : undefined}
                onClick={() =>
                  tab !== 'closed' && setMenu(sortOpen ? null : { kind: 'filter', name: 'sort' })
                }
              >
                <span className="fk">Sort</span>
                <span className="fv">
                  {tab === 'closed' ? 'Recent' : SORTS.find(([v]) => v === sort)?.[1]}
                </span>
                <span className="fcaret" />
              </button>
              {sortOpen && (
                <div className="ibx-pop">
                  {SORTS.map(([v, l, d]) => (
                    <div
                      key={v}
                      className={'ibx-opt' + (sort === v ? ' cur' : '')}
                      onClick={() => {
                        setSort(v)
                        setMenu(null)
                      }}
                    >
                      <span>{l}</span>
                      <b>{d}</b>
                    </div>
                  ))}
                </div>
              )}
            </span>
            {filterPill('source', 'Source')}
            {/* ADR-0049 */}
            {keys.map((key) => filterPill(key, key[0].toUpperCase() + key.slice(1)))}
          </div>
        </div>
        <div className="ibx-list">
          {tab === 'closed' ? (
            <>
              {list.map((c) => (
                <DoneRow key={c.id} card={c} now={now} />
              ))}
              {!list.length && <p className="ibx-quiet">Nothing finished in the last 7 days.</p>}
              <p className="ibx-keep">
                Done keeps the last 7 days. Older cards are cleared on their own.
              </p>
            </>
          ) : (
            <>
              {list.map((c) => (
                <Card
                  key={c.id}
                  card={c}
                  open={c.id === picked?.id}
                  ready={ready.has(c.source)}
                  now={now}
                  answers={answersOf(c.id)}
                  menu={menu}
                  setMenu={setMenu}
                  onOpen={() => setOpenId((o) => ({ ...o, [tab]: c.id }))}
                  onPress={(a) => press(c, a)}
                  onPick={(b, q, o, multi) => pick(c, b, q, o, multi)}
                  onAnswer={(b, v) => setAnswer(c.id, b, v)}
                />
              ))}
              {!list.length && (
                <p className="ibx-quiet">
                  {tab === 'needs-you' ? 'All clear.' : 'Nothing is in progress.'}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function flyTo(from: DOMRect, ghost: HTMLElement, to: DOMRect): void {
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: '0',
    zIndex: '100',
    pointerEvents: 'none',
    transformOrigin: '0 0'
  })
  document.body.appendChild(ghost)
  const dx = to.left + to.width / 2 - from.left
  const dy = to.top + to.height / 2 - from.top
  ghost
    .animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        {
          transform: `translate(${dx * 0.35}px,${dy * 0.2}px) scale(.55)`,
          opacity: 0.9,
          offset: 0.35
        },
        { transform: `translate(${dx}px,${dy}px) scale(.06)`, opacity: 0.2 }
      ],
      { duration: FLY_MS, easing: 'cubic-bezier(.5,0,.75,0)' }
    )
    .finished.then(() => ghost.remove())
    .catch(() => ghost.remove())
}

function Head({
  card,
  menu,
  setMenu
}: {
  card: InboxCard
  menu: Menu
  setMenu: (m: Menu) => void
}): JSX.Element {
  const lvl = levelOf(card)
  const where = tagOf(card)
  const open = menu?.kind === 'level' && menu.card === card.id
  return (
    <div className="ibx-head">
      <div className="ibx-hl">
        {lvl !== 'normal' && <span className={'ibx-lvp ' + lvl}>{LEVEL_NAME[lvl]}</span>}
        <span className="ibx-tag" title={where}>
          {where}
        </span>
      </div>
      <button
        className={'ibx-dots' + (open ? ' on' : '')}
        onClick={(e) => {
          e.stopPropagation()
          setMenu(open ? null : { kind: 'level', card: card.id })
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="ibx-menu" onClick={(e) => e.stopPropagation()}>
          {INBOX_LEVELS.map((l) => (
            <div
              key={l}
              className={'ibx-mi' + (l === lvl ? ' cur' : '')}
              onClick={() => {
                window.api.inbox.level(card.id, l === card.level ? null : l)
                setMenu(null)
              }}
            >
              {LEVEL_NAME[l]}
              {l === card.level && <small>source</small>}
            </div>
          ))}
          <div className="ibx-msep" />
          <div
            className="ibx-mi"
            onClick={() => {
              window.api.inbox.top(card.id)
              setMenu(null)
            }}
          >
            Move to top
          </div>
          <div
            className="ibx-mi"
            onClick={() => {
              window.api.inbox.dismiss(card.id)
              setMenu(null)
            }}
          >
            Dismiss
          </div>
        </div>
      )}
    </div>
  )
}

function Note({ card, ready }: { card: InboxCard; ready: boolean }): JSX.Element | null {
  if (!ready)
    return (
      <div className="ibx-note">
        <span className="m">…</span>
        <span>This source is not ready yet — the buttons come back once it is</span>
      </div>
    )
  const n = card.note
  if (!n) return null
  if (n.kind === 'changed' || n.kind === 'reply')
    return (
      <div className={'ibx-note ' + n.kind}>
        <span className="m">{n.kind === 'reply' ? '↩' : '↻'}</span>
        <span>
          {n.kind === 'reply' && <b>The session it started replied — </b>}
          {n.text}
        </span>
      </div>
    )
  const outcome = n.outcome ?? 'failed'
  const [mark, word] = OUTCOME[outcome]
  return (
    <div className={'ibx-note ' + outcome}>
      <span className="m">{mark}</span>
      <span>
        <b>{word}</b> — {n.text}
      </span>
      {n.retry && card.lastPress && (
        <button onClick={() => window.api.inbox.retry(card.id)}>Try again ›</button>
      )}
    </div>
  )
}

function Block({
  card,
  b,
  busy,
  answers,
  onPick,
  onAnswer,
  onEnter
}: {
  card: InboxCard
  b: InboxBlock
  busy: boolean
  answers: InboxAnswers
  onPick: (block: string, q: string, option: string, multi: boolean) => void
  onAnswer: (block: string, value: ChoiceAnswer | string) => void
  onEnter: () => void
}): JSX.Element {
  if (b.type === 'text') return <div className="ibx-blk ibx-text">{b.text}</div>
  if (b.type === 'quote')
    return (
      <div className="ibx-blk ibx-quote">
        <b>{b.who}</b>
        {b.text}
      </div>
    )
  if (b.type === 'facts')
    return (
      <div className="ibx-blk ibx-facts">
        {b.items.map((f, i) => (
          <span key={i} className={f.tone ?? ''}>
            {f.text}
          </span>
        ))}
      </div>
    )
  if (b.type === 'chain')
    return (
      <div className="ibx-blk ibx-chain">
        {b.steps.map((s, i) => (
          <span key={i}>{s.text}</span>
        ))}
      </div>
    )
  if (b.type === 'input')
    return (
      <div className="ibx-blk">
        <input
          className="ibx-input"
          placeholder={b.placeholder ?? ''}
          value={String(answers[b.id] ?? '')}
          disabled={busy}
          onChange={(e) => onAnswer(b.id, e.target.value)}
        />
      </div>
    )
  const given = (answers[b.id] as ChoiceAnswer | undefined) ?? {}
  return (
    <>
      {b.questions.map((q) => {
        const a = given[q.id]
        const own = a && !Array.isArray(a) ? a.own : ''
        return (
          <div className="ibx-blk" key={q.id}>
            <div className="ibx-q">
              {q.text}
              {q.multi && <i>pick any</i>}
            </div>
            <div className="ibx-opts">
              {q.options.map((o) => (
                <button
                  key={o.id}
                  className={
                    'ibx-choice' +
                    (q.multi ? ' multi' : '') +
                    (Array.isArray(a) && a.includes(o.id) ? ' on' : '')
                  }
                  disabled={busy}
                  onClick={() => onPick(b.id, q.id, o.id, q.multi)}
                >
                  <span className="ibx-choice-text">
                    {o.label}
                    {o.detail && <i>{o.detail}</i>}
                  </span>
                  {q.recommended === o.id && <span className="rec">recommended</span>}
                </button>
              ))}
              {q.ownAnswer && (
                <input
                  className="ibx-input"
                  placeholder={`Type your own answer…${pickToPress(card) ? ' (Enter sends it)' : ''}`}
                  value={own}
                  disabled={busy}
                  onChange={(e) =>
                    onAnswer(b.id, {
                      ...given,
                      [q.id]: e.target.value ? { own: e.target.value } : []
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isComposing(e) && own.trim()) onEnter()
                  }}
                />
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}

function Card({
  card,
  open,
  ready,
  now,
  answers,
  menu,
  setMenu,
  onOpen,
  onPress,
  onPick,
  onAnswer
}: {
  card: InboxCard
  open: boolean
  ready: boolean
  now: number
  answers: InboxAnswers
  menu: Menu
  setMenu: (m: Menu) => void
  onOpen: () => void
  onPress: (a: InboxAction) => void
  onPick: (block: string, q: string, option: string, multi: boolean) => void
  onAnswer: (block: string, value: ChoiceAnswer | string) => void
}): JSX.Element {
  const acts = visibleActions(card)
  const auto = pickToPress(card)
  const p = card.press
  const pressed = p && card.actions.find((a) => a.id === p.action)
  const { out, more } = ordered(card, auto ? [] : acts)
  const can = (a: InboxAction): boolean => ready && answersComplete(card, a, answers)
  const when = <span className="ibx-time">{relTime(card.happenedAt ?? card.stateSince, now)}</span>
  const stop = (e: MouseEvent): void => e.stopPropagation()

  const undo = p?.step === 'waiting' && (
    <button className="ibx-undo" onClick={() => window.api.inbox.undo(card.id)}>
      <span className="ibx-ring" />
      Undo · <b>{secondsLeft(p.until, now)}</b> s
    </button>
  )
  const spinning = p?.step === 'working' && (
    <span className="ibx-wait">
      <span className="ibx-spin" />
      {pressed?.busyText ?? 'Working…'}
    </span>
  )
  const button = (a: InboxAction): JSX.Element => (
    <button
      key={a.id}
      className={'ibx-btn' + (a.style === 'main' ? ' main' : a.style === 'danger' ? ' danger' : '')}
      disabled={!can(a)}
      onClick={(e) => {
        e.stopPropagation()
        onPress(a)
      }}
    >
      {a.label}
      {card.suggestion?.action === a.id && <span className="rec">recommended</span>}
    </button>
  )

  if (!open) {
    const first = out[0]
    const needsOpen = !first || first.style === 'danger' || !!first.takes?.length
    return (
      <div className="ibx-item" data-cid={card.id} onClick={onOpen}>
        <Head card={card} menu={menu} setMenu={setMenu} />
        <div className="ibx-what">{card.title}</div>
        <div className="ibx-foot">
          {when}
          <div className="ibx-acts" onClick={stop}>
            {undo ||
              spinning ||
              (needsOpen ? (
                <button className="ibx-btn" onClick={onOpen}>
                  Open
                </button>
              ) : (
                button(first)
              ))}
          </div>
        </div>
      </div>
    )
  }

  const busy = !!p || !ready
  const links = card.links.length > 0 && (
    <span className="ibx-links">
      {card.links.map((l, i) => (
        <button key={i} className="ibx-link" onClick={() => openLink(l)}>
          {l.label} ›
        </button>
      ))}
    </span>
  )
  const moreOpen = menu?.kind === 'more' && menu.card === card.id
  let row: JSX.Element
  if (p?.step === 'confirm' && pressed)
    row = (
      <div className="ibx-confirm">
        <span>{pressed.confirm}</span>
        <button className="ibx-btn" onClick={() => window.api.inbox.undo(card.id)}>
          Cancel
        </button>
        <button className="ibx-btn danger" onClick={() => window.api.inbox.confirm(card.id)}>
          {pressed.label}
        </button>
      </div>
    )
  else if (p?.step === 'waiting' && pressed)
    row = (
      <div className="ibx-acts">
        <span className="ibx-wait">
          {pressed.label} in <b>{secondsLeft(p.until, now)}</b> s…
        </span>
        {undo}
      </div>
    )
  else if (p?.step === 'working')
    row = (
      <div className="ibx-acts">
        {spinning}
        {links}
      </div>
    )
  else if (!acts.length)
    row = (
      <div className="ibx-acts">
        {links}
        <button className="ibx-btn" onClick={() => window.api.inbox.dismiss(card.id)}>
          Dismiss
        </button>
      </div>
    )
  else
    row = (
      <div className="ibx-acts">
        {links}
        {more.length > 0 && (
          <button
            className="ibx-btn"
            disabled={!ready}
            onClick={(e) => {
              stop(e)
              setMenu(moreOpen ? null : { kind: 'more', card: card.id })
            }}
          >
            More ▾
          </button>
        )}
        {[...out].reverse().map(button)}
        {moreOpen && (
          <div className="ibx-menu up" onClick={stop}>
            {more.map((a) => (
              <div
                key={a.id}
                className={'ibx-mi' + (a.style === 'danger' ? ' danger' : '')}
                onClick={() => can(a) && onPress(a)}
              >
                {a.label}
              </div>
            ))}
          </div>
        )}
      </div>
    )

  return (
    <div className="ibx-item focus" data-cid={card.id}>
      <Note card={card} ready={ready} />
      <Head card={card} menu={menu} setMenu={setMenu} />
      <div className="ibx-what">{card.title}</div>
      <div className={'ibx-body' + (p ? ' busy' : '')}>
        {card.blocks.map((b, i) => (
          <Block
            key={i}
            card={card}
            b={b}
            busy={busy}
            answers={answers}
            onPick={onPick}
            onAnswer={onAnswer}
            onEnter={() => auto && can(auto.action) && onPress(auto.action)}
          />
        ))}
        {card.suggestion && (
          <div className="ibx-say">
            <span className="ibx-orb sm">
              <span />
            </span>
            <span>{card.suggestion.text}</span>
          </div>
        )}
      </div>
      <div className="ibx-foot">
        {when}
        {row}
      </div>
    </div>
  )
}

function DoneRow({ card, now }: { card: InboxCard; now: number }): JSX.Element {
  const bad = card.closedBy === 'inbox'
  return (
    <div className="ibx-item done" data-cid={card.id}>
      <div className="ibx-head">
        <div className="ibx-hl">
          <span className="ibx-tag">{tagOf(card)}</span>
        </div>
        <span className={'ibx-dstat' + (bad ? ' bad' : '')}>
          {bad ? '×' : '✓'} {card.status || 'Done'}
        </span>
      </div>
      <div className="ibx-what">{card.title}</div>
      {card.note?.kind === 'reply' && <div className="ibx-dreply">↩ {card.note.text}</div>}
      <div className="ibx-foot">
        <span className="ibx-time">{relTime(card.closedAt ?? card.stateSince, now)}</span>
        <span className="ibx-dby">{byText(card)}</span>
      </div>
    </div>
  )
}
