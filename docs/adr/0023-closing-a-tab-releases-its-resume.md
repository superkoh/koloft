# 0023 Closing a tab lets go of its resume itself

**Constraint**: a resume holds an in-flight latch on its sidebar row until something
releases it: the session binding, or the tab's exit handler. Closing a tab removes it
before the kill's exit event arrives, so the exit handler no longer finds the tab and
releases nothing; a resume that never bound has no binding to release it either. No e2e
flow closes a resume that has not bound yet.
**Decision**: `requestCloseTab`, the close path for both ⌘W and the row menu's Close,
calls `releaseResume` for the tab's session before it calls `closeTab`.
**Rejected**: deleting that call as a copy of the one in the exit handler — the row
then stays latched and every later click on it does nothing.
