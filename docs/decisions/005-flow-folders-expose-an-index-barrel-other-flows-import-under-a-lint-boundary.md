# D-005: In an app grouped by flow, each flow folder has an `index.ts` listing its public names, other flows import only that file, and a lint pattern enforces it

- Situation: an app's source is grouped into one folder per flow, and one flow's code needs code from another flow in the
  same app. The package-wide style rule allows one `index.ts` per package and no nested barrels. The question is how a
  flow imports another flow's code, and whether a lint boundary stops it from reaching past the other flow's public
  surface.
- Options:
  - A: each flow folder has an `index.ts` that lists its public names. Other flows import only that file, and a
    `no-restricted-imports` pattern in the app's ESLint config enforces it. The style guide's "no nested barrels" gains
    an exception for flow folders in an app.
  - B: no `index.ts` in a flow folder. Other flows import the module they need directly by path. No lint boundary.
  - C: no `index.ts`. Other flows import directly by path, but only modules not marked internal. Files in a flow's
    `internal/` subfolder are forbidden to other flows by a lint pattern.
- Owner: option A. "index.ts barrel + lint (Recommended)"
- Why: the owner gave no reason beyond choosing the option offered as recommended. As offered, that option gives each
  flow one readable public surface, as a package's barrel does, and makes the boundary between flows a lint error rather
  than a convention.
- Applies when:
  - an app's source is grouped into one folder per flow, and code in one flow imports code from another flow of the same
    app
  - the flow folder is inside one app, not a package, so the package-level "one barrel" rule does not already cover it
- Not when:
  - the app has no user flows and its folders are runtime responsibilities directly in `src/`, in a small app whose few
    cycles each rest on one import of a metric, a log tag or a type. Those folders get no barrel and no boundary
    (D-011).
- Source: the change that regroups the host, sandbox and protocol apps by flow, design
  `docs/_plans/app-flow-folders-design.md`.
- Status: enforced by the ESLint rule `app/feature-boundary`, defined by the helper `featureBoundaries()` in
  `config/eslint/featureBoundaries.js` and turned on in the host app's ESLint config. The rule decides. It reports a
  value import into another feature that is not that feature's `index.ts`. It allows these past a feature's index:
  - a type-only import
  - Astro markup importing an Astro component or an island by its own module. Astro hydrates the module the markup
    imports, so an index never lists a page's islands. An island is told by its `Island` suffix (D-012).
  - test code: specs, stories, fakes, `__tests__` and `src/testing`

  It still reports kit or a feature importing the shell or the pages, and kit importing a feature at runtime.
