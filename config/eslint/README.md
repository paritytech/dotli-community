# `@config/eslint`

Shared ESLint flat configs and the helpers that turn package layering into import bans. Internal (`private`).

## Responsibility

- **Owns:** the lint rules every package shares, and the import-ban helpers.
- **Does not own:** a package's allow-list. Each package lists what it may import in its own lint config.

## Design

- **`base`:** `@eslint/js` and `typescript-eslint` recommended, Prettier compat, the Turbo env-var rule.
- **`vite`:** extends `base` for TypeScript code. Type-aware strict rules, Solid for `.tsx`, and the repo's code-style
  bans.
- **`astro`:** extends `vite` with Astro rules. Type-aware rules are off in `.astro` files, where `astro check` runs.
- **Tests and stories:** matched by file pattern, so one config covers all of them.

## Entry points

| Entry                  | Exports                        |
| ---------------------- | ------------------------------ |
| `@config/eslint/base`  | `config`                       |
| `@config/eslint/vite`  | `config` and the helpers below |
| `@config/eslint/astro` | `config`, for Astro apps       |

| Helper                                | What it does                                                    |
| ------------------------------------- | --------------------------------------------------------------- |
| `importBans(bans, within?)`           | Bans imports that cross a layer, optionally in some files only. |
| `onlyAllowedScopes(allowed, message)` | Refuses every workspace-scope import except `allowed`.          |
| `dynamicImportBan(pattern, message)`  | Refuses `import()` of a matching module.                        |
| `fixedConfigOnly`                     | Limits a zone of files to the configuration's fixed entry.      |
| `restrictedSyntax`                    | The shared syntax bans, for a package with its own rule.        |

## Usage

```js
import { config } from '@config/eslint/vite';

export default config;
```

A package that bans imports adds its own `tsconfigRootDir` and spreads `importBans(...)` after `config`.
