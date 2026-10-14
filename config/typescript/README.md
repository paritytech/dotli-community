# `@config/typescript`

Shared `tsconfig` bases for the monorepo, so every package compiles under the same strict settings.

## Responsibility

- Hold the compiler options every package extends.
- Not a package's own `include`, `paths` or project references: each package keeps those in its own TypeScript config.

## Design

- `@config/typescript/base.json` targets ES2022 with DOM libs and `NodeNext` resolution. It is strict and adds
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`
  and `erasableSyntaxOnly`. It is `noEmit` and checks JS files. It allows `.ts` import extensions for the files Node
  loads directly.
- `@config/typescript/node.json` extends the base with `lib: ES2024` and Node types, for tooling packages.
- Shipped code targets ES2022. A workspace whose tests use ES2024 APIs raises `lib` to ES2024 in its own config and
  checks its shipped sources against ES2022 with a second, shipped-only config, which its `typecheck` script runs too.
- `@config/typescript/solid.json` adds the JSX settings (`preserve`, `@solidjs/web`). Combine it with the base.
- `@config/typescript/vite-env.d.ts` declares the `VITE_*` keys of `import.meta.env`, so dot access passes
  `noPropertyAccessFromIndexSignature`. Vite inlines only dot reads. It also types `?inline-script` imports as a string.

## Entry points

A package extends one or more files from its TypeScript config:

```json
{ "extends": ["@config/typescript/base.json", "@config/typescript/solid.json"] }
```

Astro apps also extend `astro/tsconfigs/strict`.
