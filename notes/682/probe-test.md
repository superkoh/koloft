# Issue 682 probe: the glue reproduced in the tracker, every time

Paste into `test/unit/sessionTracker.test.ts`, inside
`describe('SessionTracker — what each turn said: …')`, right after the case
"a Stop that comes before the reply is on disk waits for it, …". It uses that block's
own helpers (`human`, `said`, `text`, `writeJsonl`, `waitFor`, `newTracker`,
`TURN_TEXT_WAIT_SHORTENED_MS`).

Run: `npx vitest run test/unit/sessionTracker.test.ts -t 'PROBE 682'`

Result on `main` 668a5d18 and on PR #1817's `sessionTracker.ts`: both cases fail,
every run, with one turn whose reply is `"Creating NOTES.md.\n\nPicked: Green"`.

```ts
for (const [name, opener] of [
  [
    'bare slash echo',
    { type: 'user', message: { role: 'user', content: '/ask Which colour?|Red|Green' } }
  ],
  [
    'task-notification',
    {
      type: 'user',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification><status>completed</status>' }
    }
  ]
] as const)
  it(`PROBE 682 ${name}: a turn that ends on a tool call is not glued to the next turn's text`, async () => {
    const cwd = makeWorkspace({})
    const tracker = newTracker()
    const ended: { turn: { reply: string } }[] = []
    tracker.on('turn-ended', (e) => ended.push(e))
    tracker.track('tab682', cwd)
    const sid = `6820000${name.length}-2222-4222-8222-222222222222`
    const file = writeJsonl(cwd, sid, [human('earlier question', 1), said(text('earlier'), 2)])
    tracker.bindSession('tab682', file, sid, cwd)
    await waitFor(tracker, (x) => x.tabId === 'tab682' && x.title === 'earlier question')
    const now = (): string => new Date().toISOString()
    const append = (line: object): void =>
      fs.appendFileSync(file, JSON.stringify({ ...line, timestamp: now() }) + '\n')
    append(human('Set up the project notes', 30) as object)
    append({
      type: 'assistant',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Creating NOTES.md.' },
          { type: 'tool_use', id: 'toolu_w', name: 'Write', input: {} }
        ]
      }
    })
    tracker.receive('tab682', { type: 'stop' })
    await new Promise((r) => setTimeout(r, TURN_TEXT_WAIT_SHORTENED_MS / 3))
    append(opener)
    append(said(text('Picked: Green'), 40) as object)
    tracker.receive('tab682', { type: 'stop' })
    await new Promise((r) => setTimeout(r, TURN_TEXT_WAIT_SHORTENED_MS * 2))
    expect(ended.map((e) => e.turn.reply)).toEqual(['Creating NOTES.md.', 'Picked: Green'])
  })
```

What it shows: a turn whose last assistant record is a tool call has `replyDone`
false at its Stop, so the tracker keeps it open for `TURN_TEXT_WAIT_MS` (5 s) waiting
for its late text. A `user` record that opens no visible turn (the fake's bare `/ask …`
line, read as Claude Code's command echo; or a `task-notification`) does not close it,
so the next turn's text is taken as the late reply.
