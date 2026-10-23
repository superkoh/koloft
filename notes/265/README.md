# #265 probe: can a Claude session on another machine SendMessage a Claude session here?

Run: `node notes/265/probe-send-message-across-machines.mjs <linux claude binary>`
(Docker; the binary from `npm pack @anthropic-ai/claude-code-linux-arm64@2.1.309`; it
lends the first enabled Claude account of the installed Koloft through a 0600 file and
never prints it). Output of the last run: `probe-output.txt`.

Two containers from the e2e `sshd.Dockerfile` image stand for two machines: "home" runs
an interactive `claude -n home-session` in tmux, and each side runs one `claude -p`
(model haiku) told to call ListAgents and then SendMessage `home-session`.

Result: on "home" ListAgents lists `home-session` and the message reaches its
transcript. On "machine" ListAgents says "No reachable agents — no other Claude session
is running on this machine right now" and SendMessage answers
`No agent named 'home-session' is reachable.`; nothing reaches the receiver.
