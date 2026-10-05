const token = process.env.KOLOFT_PROBE_TOKEN
if (!token) {
  console.error('Set KOLOFT_PROBE_TOKEN to a Claude OAuth access token (sk-ant-oat...).')
  process.exit(1)
}

const models = ['claude-fable-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-sonnet-5-5']

for (const model of models) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: 'user', content: 'hi' }]
    })
  })
  const unified = [...res.headers.keys()]
    .filter((k) => k.startsWith('anthropic-ratelimit-unified-'))
    .map((k) => k.slice('anthropic-ratelimit-unified-'.length))
    .sort()
  console.log(`${model}: HTTP ${res.status}`)
  console.log(`  unified headers: ${unified.join(', ') || '(none)'}`)
  console.log(`  has 7d_oi: ${unified.includes('7d_oi-utilization') ? 'yes' : 'no'}`)
}
