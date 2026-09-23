# 0003 No add buttons for API-key and custom-endpoint accounts yet

**Constraint**: neither add-and-verify path has ever run against a real credential. An
API key is billed per token, so its first real use must not be someone's production key
on a path no one has tried.
**Decision**: both account kinds are built and unit-tested, and an existing one still
works, but the Accounts pane shows no button to add one. So the "fall back to a metered
account when every subscription is walled" tier is empty in practice.
**Rejected**: showing "Add API key" and "Add custom endpoint" now because the code
behind them exists.
