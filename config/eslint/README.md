# `@config/eslint`

Shared ESLint flat configurations used across the dot.li monorepo. Internal, workspace-only package (`private`); not
published to npm.

## Exports

| Entry                  | Use                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@config/eslint/base`  | Base config: `@eslint/js` recommended, `typescript-eslint` recommended, Prettier compat, Turbo plugin.                                           |
| `@config/eslint/vite`  | Vite + TypeScript apps: extends base with `strictTypeChecked` + `stylisticTypeChecked` rules.                                                    |
| `@config/eslint/astro` | Astro apps: extends vite with `eslint-plugin-astro` recommended for `.astro` components; type-aware rules off there (`astro check` covers them). |

## Usage

Each package re-exports one of these from its own `eslint.config.js`:

```js
import { config } from '@config/eslint/vite';

export default config;
```

Both entries export a flat-config array (`Linter.Config[]`) and require ESLint 9+ (`eslint.config.js`).
