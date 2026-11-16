# D-010: In an app grouped by flow behind `index.ts` boundaries, each flow folder holds the on-demand chunk loaders for its own modules, and the app-wide loader module keeps only those for modules outside any flow

- Situation: an app's source is grouped into one folder per flow, each behind an `index.ts` that a lint boundary makes
  the only file other flows may import. The app loads some modules on demand through loader functions that wrap a
  dynamic `import()`, and those loaders sit together in one app-wide module, so it reaches into the internals of several
  flows. The question is where the loaders live once the boundary is in place, and whether any module is exempt from it.
- Options:
  - A: each flow has its own loader module, such as a `lazy.ts`, holding the loaders for its own on-demand modules and
    exported through its `index.ts`. The app-wide loader module, in the shared helpers folder, keeps only loaders for
    modules outside any flow, such as packages. The placement rule names a flow's loader module too.
  - B: one app-wide loader module stays in the shared helpers folder, and the lint boundary exempts it, so it alone may
    import a flow's internals.
  - C: one app-wide loader module moves to the shell, the folder that composes the app and may import flows, and the
    lint boundary exempts its deep `import()` calls.
- Owner: option A. "Per-feature lazy.ts (Recommended)"
- Why: the owner gave no reason beyond choosing the option offered as recommended. As offered, that option keeps the
  flow boundary whole with no exemption: a flow's on-demand modules are loaded through its own public surface, and only
  loaders for code that belongs to no flow stay app-wide.
- Applies when:
  - an app's source is grouped into one folder per flow behind an `index.ts` and a lint boundary, and the app loads some
    modules on demand through loader functions
  - a loader for a module inside a flow lives in that flow's own loader module and is exported through its `index.ts`
  - a loader for a module outside any flow, such as a package, stays in the app-wide loader module in the shared helpers
    folder
  - no module is exempted from the flow boundary to hold loaders
- Not when:
  - the placement rule built on this decision says a flow's index never re-exports a module a loader loads. That rule
    does not hold when every importer that uses the export sits in a lazily loaded chunk and needs the module
    synchronously: the index may re-export it, and an eager caller still uses the loader (D-014).
- Source: the change that regroups the host, sandbox and protocol apps by flow, design
  `docs/_plans/app-flow-folders-design.md`.
- Status: superseded by D-015. The owner reversed it outright on the same change: after option D was built and
  measured, "Keep it".
