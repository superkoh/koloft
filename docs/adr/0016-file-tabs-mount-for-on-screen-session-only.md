# 0016 File tabs stay mounted only for the session on screen

**Constraint**: each file tab runs a Shiki pass, a markdown pipeline and a file watch,
a session can have up to 8, and unlike web guests there is no global cap on them.
**Decision**: only the on-screen session's visited file tabs stay mounted. Switching
sessions unmounts them: each one leaves its scroll offset on its tab as it goes and
scrolls back to it when it mounts again, but lazy mermaid blocks draw again. A test
that switches sessions and then touches a file tab must wait for the remount.
**Rejected**: keeping every session's file tabs mounted, as web guests and shells are —
the cost grows with the session list just to keep a scroll offset.
