# 0027 Koloft talks to Discord with its own small client, not discord.js

**Constraint**: every runtime dependency ships inside the app (`externalizeDepsPlugin`
in `electron.vite.config.ts` leaves `dependencies` out of the bundle and electron-builder
copies them whole into the asar). Koloft needs only a handful of Discord calls: who the
bot is, its servers and channels, sending a message, and one Gateway connection.
**Decision**: a hand-written client — Node `fetch` for REST and the `ws` package Koloft
already ships for the Gateway (heartbeat, resume, rate-limit queue).
**Rejected**: discord.js — the usual choice, but it brings its own network stack and
several packages, all copied into every install for a few calls.
