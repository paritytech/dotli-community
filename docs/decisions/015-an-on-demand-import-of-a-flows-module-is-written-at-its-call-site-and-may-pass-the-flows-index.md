# D-015: In an app grouped by flow behind `index.ts` boundaries, each caller writes its `import()` of a flow's module in place, the lint boundary lets an `import()` name a module inside another flow, and flows hold no loader modules

- Situation: an app's source is grouped into one folder per flow, each behind an `index.ts` that a lint boundary makes
  the only file other flows may import. The app loads some modules on demand with a dynamic `import()`, so each stays a
  separate chunk. The question is where the `import()` of a module inside a flow lives, whether it sits in a loader
  module, and whether it may reach past the flow's index.
- Options:
  - A: each flow keeps a loader module, such as a `lazy.ts`, for its own on-demand modules, exported through its
    `index.ts`. No module is exempt from the boundary (D-010).
  - B: one app-wide loader module in the shared helpers folder, exempted from the boundary.
  - C: one app-wide loader module in the shell, the folder that composes the app, whose deep `import()` calls the
    boundary exempts.
  - D: no loader modules in flows. Each caller writes its `import()` of the flow's internal module in place, and the
    lint boundary lets an `import()` (never a static value import) name a module inside another flow, since the call
    names the chunk it loads. The shared helpers folder keeps loaders for package modules only, and still never imports
    a flow at runtime.
- Owner: option D. First "Now measure eager paths on main, then on this branch. After that try to remove lazy barrel
  from features, make it as simple as possible an measure the impact", then, after seeing option D built and measured,
  "Keep it".
- Why: the owner asked for the simplest form and kept it once measured. Option D made the eager path gzip 1.3 to 1.4 KB
  smaller on every host page than option A, since no flow index carries loader exports into the eager pages.
- Applies when:
  - an app's source is grouped into one folder per flow behind an `index.ts` and a lint boundary, and code loads a
    module inside a flow on demand
  - the caller writes the `import()` of that module where it needs it, with no loader module in the flow and no loader
    export in the flow's index
  - only an `import()` may name a module inside another flow. A static value import still goes through the index.
  - a loader for a module outside any flow, such as a package, stays in the app-wide loader module in the shared helpers
    folder, which never imports a flow at runtime, not even with an `import()`
- Source: the change that regroups the host, sandbox and protocol apps by flow, design
  `docs/_plans/app-flow-folders-design.md`, commit ff58fc12f on branch `refactor/app-flow-folders`.
- Status: active. It supersedes D-010. The ESLint rule `app/feature-boundary` (D-005) allows the `import()` past a
  flow's index and still reports the shared helpers folder importing a flow at runtime.
