# `@config/eslint`

Shared ESLint flat configs and the import-layer helpers that enforce the package layering. Internal, workspace-only
(`private`).

## Responsibility

- Hold the lint rules every package shares: type-aware strict TypeScript, Solid, Astro and the repo's code-style bans.
- Hold the helpers that turn the layering in `AGENTS.md` into import bans a package's `eslint.config.js` applies.
- Not a package's own allow-list: each package lists what it may import in its own lint config.

## Design

- The base config is the minimal config: `@eslint/js` recommended, `typescript-eslint` recommended, Prettier compat and
  the Turbo env-var rule. It ignores `dist/**`.
- The vite config extends it for TypeScript apps and packages with `strictTypeChecked` and `stylisticTypeChecked`, the
  project service, and error-level rules for unsafe `any`, floating promises, strict booleans, no `console`, no non-null
  assertions and braces on every block. It also loads the Solid plugin for `.tsx`.
- The astro config extends the vite config with `eslint-plugin-astro`. Type-aware rules are off in `.astro` files, where
  `astro check` covers them.
- The vite config also carries the shared bans: silent `catch {}`, error wrapping by `err.message` concatenation, and
  `_FAILURE`, `_TIMEOUT`, `_RETRY` or `_RETRIES` metric constants. It refuses `.ts` import extensions in shipped code,
  imports of test-only modules (specs, fakes, testing folders and `@dotli/*/testing`) from shipped code, and DOM tooling
  in unit specs.
- Specs, tests and stories are matched by file pattern, so one config covers all of them.

## Entry points

| Entry                  | Use                                                          |
| ---------------------- | ------------------------------------------------------------ |
| `@config/eslint/base`  | `config`: the base config.                                   |
| `@config/eslint/vite`  | `config` and the helpers below.                              |
| `@config/eslint/astro` | `config`: the vite config plus Astro rules, for `apps/host`. |

Helpers from `@config/eslint/vite`:

- `importBans(bans, within?)`: bans imports that cross a layer, optionally only in some files.
- `onlyAllowedScopes(allowed, message)`: refuses every `@dotli/*`, `@config/*` and `@parity/*` import but `allowed`.
- `dynamicImportBan(pattern, message)`: refuses `import()` of a matching module.
- `fixedServicesConfigOnly(files)`: limits those files to the fixed services part of the configuration.
- `metricsPackageConfig`: the rules for the metrics package itself.
- `restrictedSyntax`: the shared syntax bans, for a package that adds its own `no-restricted-syntax` rule.

Each package re-exports a config from its own lint config:

```js
import { config } from '@config/eslint/vite';

export default config;
```

A package that bans imports adds its own `tsconfigRootDir` and spreads `importBans(...)` after `config`.
