# 0010 Koloft draws its own extension button row

**Constraint**: the extensions library's `<browser-action-list>` draws inside a shadow
DOM that Koloft can neither label for screen readers nor style.
**Decision**: Koloft reads the library's browserAction state
(`window.browserAction.getState`) and draws its own row of buttons, with an overflow
menu, from it.
**Rejected**: mounting the library's `<browser-action-list>` — less code, but the
buttons cannot be labelled or styled.
