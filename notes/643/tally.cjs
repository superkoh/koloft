const fs = require('fs')
const path = require('path')

const FIRST_LAUNCH_AFTER_A_BOOT = new Set([1, 2, 7, 8, 13, 14])
const lines = fs
  .readFileSync(path.join(__dirname, 'vm-rounds.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l.replace(/^SUMMARY /, '')))

lines.forEach((l, i) => {
  const [front, back] = l.guests
  console.log(
    [
      String(i + 1).padStart(2),
      FIRST_LAUNCH_AFTER_A_BOOT.has(i + 1) ? 'first-launch' : 'later-launch',
      l.state.padEnd(17),
      `throttling=${l.throttling}`.padEnd(28),
      `round ${l.round}`,
      `| front page: picture=${front.picture === 'iframe drawn' ? 'ok' : 'NO'}`,
      `iframe-session click=${front.clickThroughIframeSession}`,
      `root click on iframe=${front.rootClickOnIframe}`,
      `on parent=${front.rootClickOnParent}`,
      `unanswered=${front.noAnswerIn8s}`,
      `| hidden page: iframe-session click=${back.clickThroughIframeSession}`,
      `root click on iframe=${back.rootClickOnIframe}`
    ].join('  ')
  )
})
