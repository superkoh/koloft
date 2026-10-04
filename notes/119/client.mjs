const url = process.argv[2]
const timer = setTimeout(() => {
  console.log('CLIENT timeout')
  process.exit(3)
}, 5000)
try {
  const ws = new WebSocket(url)
  ws.onopen = () => ws.send('ping-from-sandbox')
  ws.onmessage = (e) => {
    console.log('CLIENT got', String(e.data))
    clearTimeout(timer)
    process.exit(0)
  }
  ws.onerror = (e) => {
    console.log('CLIENT error', e?.message ?? e?.error?.message ?? String(e?.error ?? e))
    clearTimeout(timer)
    process.exit(2)
  }
} catch (e) {
  console.log('CLIENT threw', e.message)
  process.exit(4)
}
