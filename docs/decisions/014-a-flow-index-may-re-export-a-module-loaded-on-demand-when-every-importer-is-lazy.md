# D-014: A flow's `index.ts` may re-export a module that is also loaded on demand with an `import()` when every importer that uses that export sits in a lazily loaded chunk, and an eager caller writes its own `import()`

- Situation: an app is grouped by flow behind `index.ts` boundaries, and a module inside a flow is loaded on demand with
  an `import()` (D-015). A flow has a page-wide module, such as a store instance or a provider module, that loads on
  demand so the eager page does not carry it. Code that already lives in a lazily loaded chunk, such as the callbacks of
  the folder that owns an external protocol's side or another module of the same flow, needs that same module
  synchronously. The placement rule says a flow's index never re-exports a module that is loaded on demand. The
  question is whether the index may re-export it anyway, or how else the lazy code gets the module.
- Options:
  - A: a narrow exception. A flow's index may re-export a module that is also loaded on demand when every importer that
    uses that export sits in a lazily loaded chunk. Tree shaking keeps it out of the eager pages, and the CI startup
    budgets guard it. An eager caller loads it on demand.
  - B: the composition root loads the module on demand and passes the instance in as a parameter. The index never
    re-exports it.
  - C: every user takes an async source and awaits the on-demand load on each call.
- Owner: option A. "Narrow placement exception (Recommended)"
- Why: the owner gave no reason beyond choosing the option offered as recommended. As offered, code that is already
  lazy reads the module synchronously through the flow's public surface, while tree shaking keeps the module out of the
  eager pages and the CI startup budgets catch a regression.
- Applies when:
  - a flow's index would re-export a module that some caller also loads on demand with an `import()`
  - every importer that uses that export sits in a lazily loaded chunk and needs the module synchronously
  - an eager caller of the same module writes its own `import()` of it, never using the re-export
  - the CI startup size budgets guard what the eager pages load
- Not when:
  - any importer that uses the export sits on an eager page. It loads the module with its own `import()`, and the
    general rule holds: the index does not re-export the module for it.
- Source: the change that regroups the host, sandbox and protocol apps by flow, design
  `docs/_plans/app-flow-folders-design.md`, review `docs/_reviews/app-flow-folders-review.md` (findings M1, M2). The
  owner chose it while each flow held its own loader module (D-010). Restated without that loader once D-015 dropped
  it, commit ff58fc12f on branch `refactor/app-flow-folders`. The case still occurs: a flow index re-exports a store
  module that another module of the flow loads with an `import()`.
- Status: active. It narrows the placement rule "a feature's `index.ts` never re-exports a module an `import()` loads"
  (`docs/code/placement.md` § Inside a package), which rests on D-015 and D-005.
