for (const button of document.querySelectorAll('.copy')) {
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent)
    button.classList.add('copied')
    clearTimeout(button.timer)
    button.timer = setTimeout(() => button.classList.remove('copied'), 1800)
  })
}

for (const table of document.querySelectorAll('.typed-table table')) {
  const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim())
  for (const row of table.querySelectorAll('tbody tr')) {
    for (const [i, cell] of [...row.cells].entries()) {
      if (heads[i]) cell.dataset.label = heads[i]
    }
  }
}

const nav = document.querySelector('.nav')
const menu = nav.querySelector('.menu')
menu.addEventListener('click', () => {
  const open = nav.classList.toggle('open')
  menu.setAttribute('aria-expanded', String(open))
})
nav.querySelector('.links').addEventListener('click', (e) => {
  if (e.target.closest('a')) {
    nav.classList.remove('open')
    menu.setAttribute('aria-expanded', 'false')
  }
})

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const DEMO = 'demo/player.html'
const FULL_FRAME = '0,0,1440,860'
const AUTO_NEXT_TAB_MS = 3500
const wins = [...document.querySelectorAll('.win[data-film]')]
const winOfFrame = new Map()
const narrow = matchMedia('(max-width: 700px)')

function frameAt(marks, at) {
  if (typeof at === 'number') return at
  const [, name, offset] = /^([a-z-]+)([+-]\d+)?$/.exec(at) ?? []
  return name in marks ? marks[name] + Number(offset ?? 0) : Infinity
}

function camAt(win, i) {
  if (narrow.matches && win.dataset.phoneCrop) return win.dataset.phoneCrop
  const cams = (win.cams ??= JSON.parse(win.dataset.cam || '[]')).filter((c) => c.at <= i)
  return cams.at(-1)?.crop || win.dataset.crop || FULL_FRAME
}

function layout(win) {
  const width = win.clientWidth
  const [, , bw, bh] = camAt(win, -1).split(',').map(Number)
  const [x, y, w] = (win.dataset.cur || camAt(win, -1)).split(',').map(Number)
  win.style.height = (bh * width) / bw + 'px'
  if (win.frame) win.frame.style.transform = `scale(${width / w}) translate(${-x}px, ${-y}px)`
}

function post(win, koloft) {
  win.frame?.contentWindow.postMessage({ koloft }, '*')
}

function sync(win) {
  if (!win.classList.contains('ready')) return
  const want = win.visible && !win.hidden && !win.userPaused && !document.hidden
  if (want !== win.playing) post(win, want ? 'play' : 'pause')
  win.playing = want
  win.classList.toggle('paused', !!win.userPaused)
}

function mount(win) {
  if (win.frame) return
  win.dataset.cur = camAt(win, 0)
  const frame = (win.frame = document.createElement('iframe'))
  frame.title = win.dataset.title || 'Koloft, recorded'
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.src = `${DEMO}?film=${win.dataset.film}&from=${encodeURIComponent(win.dataset.from || 0)}`
  win.append(frame)
  winOfFrame.set(frame.contentWindow, win)
  win.cues = JSON.parse(win.dataset.cues || '[]').map((cue) => {
    const el = document.createElement('div')
    el.className = 'cue'
    el.innerHTML = cue.html
    el.style.left = cue.x
    el.style.top = cue.y
    win.append(el)
    return { el, at: cue.at, to: cue.to ?? Infinity }
  })
  if (!reduceMotion) {
    const ctl = document.createElement('button')
    ctl.type = 'button'
    ctl.className = 'ctl'
    ctl.setAttribute('aria-label', 'Pause or play this recording')
    ctl.innerHTML = document.getElementById('ctl-icons').innerHTML
    ctl.addEventListener('click', () => {
      win.userPaused = !win.userPaused
      sync(win)
    })
    win.append(ctl)
  }
  layout(win)
}

for (const win of wins) layout(win)
addEventListener('resize', () => wins.forEach(layout))
narrow.addEventListener('change', () =>
  wins.forEach((win) => {
    delete win.dataset.cur
    layout(win)
  })
)
document.addEventListener('visibilitychange', () => wins.forEach(sync))

const tabWins = [...document.querySelectorAll('.tabwins .win')]
const tabButtons = [...document.querySelectorAll('.tabs [role=tab]')]
let tabIndex = 0
let autoRotate = !reduceMotion
let nextTabTimer = 0

function showTab(n, focus) {
  clearTimeout(nextTabTimer)
  tabIndex = n
  tabButtons.forEach((b, i) => {
    b.setAttribute('aria-selected', String(i === n))
    b.tabIndex = i === n ? 0 : -1
    b.style.setProperty('--p', '0%')
  })
  if (focus) tabButtons[n].focus()
  tabWins.forEach((w, i) => {
    w.hidden = i !== n
    if (w.hidden) sync(w)
  })
  const win = tabWins[n]
  mount(win)
  layout(win)
  if (win.classList.contains('ready')) {
    post(win, 'restart')
    win.playing = true
    sync(win)
  }
}

tabButtons.forEach((b, i) => {
  b.addEventListener('click', () => {
    autoRotate = false
    showTab(i)
  })
  b.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
    if (!step) return
    e.preventDefault()
    autoRotate = false
    showTab((i + step + tabButtons.length) % tabButtons.length, true)
  })
})

addEventListener('message', (e) => {
  const win = winOfFrame.get(e.source)
  const d = e.data
  if (!win || !d) return
  if (!win.classList.contains('ready')) {
    const marks = d.marks || {}
    for (const cue of win.cues) {
      cue.at = frameAt(marks, cue.at)
      cue.to = frameAt(marks, cue.to)
    }
    win.cams = JSON.parse(win.dataset.cam || '[]').map((c) => ({ ...c, at: frameAt(marks, c.at) }))
    win.classList.add('ready')
    win.playing = d.koloftFrame !== undefined
    sync(win)
  }
  if (d.koloftFrame === undefined) return
  const i = d.koloftFrame
  for (const cue of win.cues) cue.el.classList.toggle('on', i >= cue.at && i <= cue.to)
  const crop = camAt(win, i)
  if (crop !== win.dataset.cur) {
    win.dataset.cur = crop
    layout(win)
  }
  if (win === tabWins[tabIndex]) {
    tabButtons[tabIndex].style.setProperty('--p', ((i + 1) / d.of) * 100 + '%')
    if (autoRotate && i === d.of - 1) {
      nextTabTimer = setTimeout(
        () => autoRotate && showTab((tabIndex + 1) % tabWins.length),
        AUTO_NEXT_TAB_MS
      )
    }
  }
})

const near = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      if (e.target.closest('.tabwins')) showTab(tabIndex)
      else mount(e.target)
      near.unobserve(e.target)
    }
  },
  { rootMargin: '600px 0px' }
)
const seen = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      e.target.visible = e.isIntersecting && e.intersectionRatio >= 0.15
      sync(e.target)
    }
  },
  { threshold: [0, 0.15, 0.5] }
)
for (const win of wins) seen.observe(win)
wins.filter((w) => !w.closest('.tabwins')).forEach((w) => near.observe(w))
if (tabWins.length) near.observe(tabWins[0])

const reveal = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      e.target.classList.add('in')
      reveal.unobserve(e.target)
    }
  },
  { threshold: 0.15 }
)
for (const el of document.querySelectorAll('.reveal, .stage')) reveal.observe(el)

for (const tile of document.querySelectorAll('.tile')) {
  tile.addEventListener('pointermove', (e) => {
    const r = tile.getBoundingClientRect()
    tile.style.setProperty('--mx', e.clientX - r.left + 'px')
    tile.style.setProperty('--my', e.clientY - r.top + 'px')
  })
}

const spyLinks = [...document.querySelectorAll('.nav .links a[href^="#"]')]
const spy = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const link = spyLinks.find((a) => a.hash === '#' + e.target.id)
      if (e.isIntersecting) link?.setAttribute('aria-current', 'true')
      else link?.removeAttribute('aria-current')
    }
  },
  { rootMargin: '-45% 0px -50% 0px' }
)
for (const a of spyLinks) {
  const section = document.querySelector(a.hash)
  if (section) spy.observe(section)
}
