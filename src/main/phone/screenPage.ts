export const SCREEN_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phone</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f4f2; --fg: #222; --muted: #777; --btn: #e6e6e3; --line: #ccc; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1e1e1e; --fg: #ddd; --muted: #999; --btn: #333; --line: #555; } }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 12px -apple-system, system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; }
  .bar { flex: none; height: 36px; display: flex; gap: 8px; align-items: center; }
  button { background: var(--btn); color: var(--fg); border: 1px solid var(--line); border-radius: 5px; padding: 3px 10px; font: inherit; }
  #note { color: var(--muted); }
  .stage { flex: 1; min-height: 0; width: 100%; display: flex; align-items: center; justify-content: center; padding-bottom: 8px; box-sizing: border-box; }
  canvas { max-width: 100%; max-height: 100%; background: #000; border-radius: 8px; touch-action: none; cursor: pointer; outline: none; }
</style>
</head>
<body>
<div class="bar">
  <button data-key="back" hidden>Back</button>
  <button data-key="home">Home</button>
  <span id="note">Connecting…</span>
</div>
<div class="stage"><canvas id="screen" tabindex="0" width="1" height="1"></canvas></div>
<script>
  const canvas = document.getElementById('screen')
  const note = document.getElementById('note')
  const g = canvas.getContext('2d')
  const ws = new WebSocket(location.href.replace(/^http/, 'ws').replace(/\\/?$/, '/ws'))
  ws.binaryType = 'blob'
  let drawing = false
  let waiting = null
  async function draw(blob) {
    if (drawing) { waiting = blob; return }
    drawing = true
    try {
      const bmp = await createImageBitmap(blob)
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height }
      g.drawImage(bmp, 0, 0)
      bmp.close()
    } catch {}
    drawing = false
    if (waiting) { const b = waiting; waiting = null; draw(b) }
  }
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return draw(e.data)
    const m = JSON.parse(e.data)
    note.textContent = m.note
    document.querySelector('[data-key=back]').hidden = m.kind !== 'android'
  }
  ws.onclose = () => { note.textContent = 'The phone is off.' }
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)) }
  const at = (e) => {
    const r = canvas.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }
  }
  let down = false
  canvas.addEventListener('pointerdown', (e) => { down = true; canvas.setPointerCapture(e.pointerId); canvas.focus(); send({ t: 'touch', phase: 'down', ...at(e) }) })
  canvas.addEventListener('pointermove', (e) => { if (down) send({ t: 'touch', phase: 'move', ...at(e) }) })
  const up = (e) => { if (!down) return; down = false; send({ t: 'touch', phase: 'up', ...at(e) }) }
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointercancel', up)
  document.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => send({ t: 'key', key: b.dataset.key })))
  const KEYS = { Enter: 'enter', Backspace: 'delete' }
  canvas.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (KEYS[e.key]) send({ t: 'key', key: KEYS[e.key] })
    else if (e.key.length === 1) send({ t: 'text', text: e.key })
    else return
    e.preventDefault()
  })
</script>
</body>
</html>
`
