const fs = require('fs')
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  let j = {}
  try {
    j = JSON.parse(input)
  } catch {}
  fs.appendFileSync(
    process.argv[2],
    JSON.stringify({
      event: j.hook_event_name,
      session_id: j.session_id,
      PROBE_TAB: process.env.PROBE_TAB ?? null,
      ZDOTDIR: process.env.ZDOTDIR ?? null,
      SERVER_TAG: process.env.SERVER_TAG ?? null
    }) + '\n'
  )
})
