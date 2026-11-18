# 0051 A plugin owns its whole feature, and core never names a plugin

**Constraint**: the owner wants each feature to be one piece that can be turned off as a
whole — its sentences for agents, its commands, the session moments it listens to, its
settings, its buttons and pages, its code — with nothing left behind. The owner also
decided that the format is built so that people outside the repo can write plugins later,
even though only built-in plugins ship for now.
**Decision**: a feature is a plugin in `src/plugins/<id>/`. Its `plugin.ts` is a manifest of
plain data, typed by `src/core/plugin.ts`: an id, a name, whether it is mandatory, the
plugins it needs, a format version, and a typed place for each thing it owns. Code that
runs (handlers, React parts) stays in the plugin's own `main/`, `renderer/` and `shared/`
folders and registers itself; it is never put into the manifest. `src/core/` and the rest
of the app never name a plugin: the files that name plugins are the lists in
`src/plugins/` — `list.ts`, the manifests, which core reads, and `bridges.ts`, each
plugin's part of the window's preload bridge, which the preload builds `window.api` from
and the window takes its type from. So a text block names no reader: it
names the slot it fills, and core keeps no list of readers. A plugin
imports core, the `api.ts` of the plugins it says it needs, and itself. Until a test holds
the manifest's shape, that shape may still change at version 1; once one does, the
version goes up whenever a manifest written for the old version would no longer mean the
same thing.
**Rejected**: core calling each feature by name and checking a switch at each call — every
new feature then edits core, and a switch that misses one call leaves a sentence or a
button behind. A list of readers in core (butler, helper, session) — the butler is a
plugin, so core would name one. Putting handlers and components in the manifest — main-process code would
then load in the window and the other way round, and Koloft could not read what a plugin
owns (for Settings ▸ Plugins, help or a switch) without starting it.
