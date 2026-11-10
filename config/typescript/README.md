# `@config/typescript`

Shared `tsconfig` bases, so every package compiles under the same strict settings.

## Responsibility

- **Owns:** the compiler options every package extends.
- **Does not own:** a package's `include`, `paths` or project references.

## Entry points

| File                              | What it sets                                                               |
| --------------------------------- | -------------------------------------------------------------------------- |
| `@config/typescript/base.json`    | ES2022, DOM, `NodeNext`, strict plus extra checks, `noEmit`.               |
| `@config/typescript/node.json`    | The base plus `lib: ES2024` and Node types, for tooling.                   |
| `@config/typescript/solid.json`   | JSX for Solid. Combine with the base.                                      |
| `@config/typescript/viteEnv.d.ts` | Types the `VITE_*` keys of `import.meta.env` and `?inline-script` imports. |

- **Dot reads only:** Vite inlines `import.meta.env.X` only when read with a dot.
- **ES2024 in tests:** a workspace may raise `lib` to ES2024, but then checks shipped sources against ES2022 with a
  second config in its `typecheck` script.

## Usage

```json
{ "extends": ["@config/typescript/base.json", "@config/typescript/solid.json"] }
```

Astro apps also extend `astro/tsconfigs/strict`.
