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
of the app never name a plugin: the one file that names plugins is the list,
`src/plugins/list.ts`, and core reads only that list. A plugin imports core, the `api.ts`
of the plugins it says it needs, and itself. The format version changes whenever a
manifest written for the old version would no longer mean the same thing; until the
registration surface is written down and held by a test, the shapes may still change at
version 1.
**Rejected**: core calling each feature by name and checking a switch at each call — every
new feature then edits core, and a switch that misses one call leaves a sentence or a
button behind. Putting handlers and components in the manifest — main-process code would
then load in the window and the other way round, and Koloft could not read what a plugin
owns (for Settings ▸ Plugins, help or a switch) without starting it.
