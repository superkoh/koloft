# 0008 The CDP relay: a secret path per tab, a fresh port, no discovery

**Constraint**: any local process can connect to a loopback port, but only a session's
own agent may reach that session's browser tabs. A port stuck on a busy number once
stopped the whole app from opening a window.
**Decision**: one WebSocket server on 127.0.0.1, on a port the OS picks fresh each run.
Each tab gets its own random 32-hex path, new each run. No listing endpoint, no `/json`
discovery, one client per endpoint, and the Settings switch is the only control.
**Rejected**: Chrome's standard `/json/list` and `/json/version`, which hand every
tab's path to any process that asks. A fixed or remembered port. A confirmation prompt
for each session, which puts a person in every agent loop.
