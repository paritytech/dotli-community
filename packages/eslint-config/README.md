# `@dotli/eslint-config`

Shared ESLint flat configurations used across the dot.li monorepo. Internal,
workspace-only package (`private`); not published to npm.

## Exports

| Entry                       | Use                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@dotli/eslint-config/base` | Base config: `@eslint/js` recommended, `typescript-eslint` recommended, Prettier compat, Turbo plugin. |
| `@dotli/eslint-config/vite` | Vite + TypeScript apps: extends base with `strictTypeChecked` + `stylisticTypeChecked` rules.          |

## Usage

Each package re-exports one of these from its own `eslint.config.js`:

```js
import { config } from "@dotli/eslint-config/vite";

export default config;
```

Both entries export a flat-config array (`Linter.Config[]`) and require ESLint 9+
(`eslint.config.js`).
