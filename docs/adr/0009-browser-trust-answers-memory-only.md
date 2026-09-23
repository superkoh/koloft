# 0009 Certificate exceptions and permission answers live in memory only

**Constraint**: clicking past a certificate warning, or answering a camera or location
prompt, is a choice for right now. Saving it would also need a screen where the user
can find it and take it back.
**Decision**: both are kept only for the life of the process. Nothing is written to
disk, a restart asks again, and no revoke screen is needed.
**Rejected**: saving the answers in settings as Chrome does — a few clicks saved, but a
new screen to manage them, and a saved exception quietly outlives its moment.
