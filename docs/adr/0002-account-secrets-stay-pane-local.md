# 0002 Pasted account secrets never reach the app store

**Constraint**: settings state normally lives in the shared store, but a pasted token
or API key must not live anywhere longer than one add call.
**Decision**: the add dialog and its secret live only in the Accounts pane's own state.
Leaving the pane throws them away, the secret field is cleared after every save
(whether it worked or not), and main never sends a secret back.
**Rejected**: moving the add dialog into the store like the other settings state and
the login flow — that keeps a secret alive across pane switches.
