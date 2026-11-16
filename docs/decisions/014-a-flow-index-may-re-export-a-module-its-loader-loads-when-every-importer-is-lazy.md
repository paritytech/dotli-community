# D-014: A flow's `index.ts` may re-export a module its own loader also loads when every importer that uses that export sits in a lazily loaded chunk, and an eager caller goes through the loader

- Situation: an app is grouped by flow behind `index.ts` boundaries, and each flow holds the on-demand loaders for its
  own modules (D-010). A flow has a page-wide module, such as a store instance or a provider module, that loads on
  demand through the flow's own loader, so the eager page does not carry it. Code that already lives in a lazily loaded
  chunk, such as the callbacks of the folder that owns an external protocol's side, needs that same module
  synchronously. The placement rule says a flow's index never re-exports a module a loader loads. The question is
  whether the index may re-export it anyway, or how else the lazy code gets the module.
- Options:
  - A: a narrow exception. A flow's index may re-export a module its own loader also loads when every importer that
    uses that export sits in a lazily loaded chunk. Tree shaking keeps it out of the eager pages, and the CI startup
    budgets guard it. An eager caller uses the loader.
  - B: the composition root loads the module through the loader and passes the instance in as a parameter. The index
    never re-exports it.
  - C: every user takes an async source and awaits the loader on each call.
- Owner: option A. "Narrow placement exception (Recommended)"
- Why: the owner gave no reason beyond choosing the option offered as recommended. As offered, code that is already
  lazy reads the module synchronously through the flow's public surface, while tree shaking keeps the module out of the
  eager pages and the CI startup budgets catch a regression.
- Applies when:
  - a flow's index would re-export a module that the flow's own loader also loads on demand
  - every importer that uses that export sits in a lazily loaded chunk and needs the module synchronously
  - an eager caller of the same module goes through the loader, never through the re-export
  - the CI startup size budgets guard what the eager pages load
- Not when:
  - any importer that uses the export sits on an eager page. It goes through the loader, and the general rule holds:
    the index does not re-export the module for it.
- Source: the change that regroups the host, sandbox and protocol apps by flow, design
  `docs/_plans/app-flow-folders-design.md`, review `docs/_reviews/app-flow-folders-review.md` (findings M1, M2).
- Status: active. It narrows the placement rule "a flow's index never re-exports a module a loader loads"
  (`docs/code/placement.md` § Inside a package), which rests on D-010 and D-005.
