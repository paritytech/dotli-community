// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import turboPlugin from "eslint-plugin-turbo";
import tseslint from "typescript-eslint";
/**
 * ESLint configuration for Vite + TypeScript apps.
 * Extends the base config with strict type-checked rules.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const config = [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-confusing-void-expression": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "no-throw-literal": "error",
      curly: ["error", "all"],

      // Deterministic-path contract rules — see
      // docs/DETERMINISM_AUDIT_2026-04-17.md §3 for rationale. Every
      // pattern here encodes one specific regression class that leaked
      // into the repo before the audit pass.
      "no-restricted-syntax": [
        "error",
        {
          // Silent catch bodies. Every `catch` must either rethrow with
          // `{ cause }`, or call `captureException` + `log.error` + emit
          // an outcome metric. Bare `catch {}` / `catch (e) {}` swallows
          // the cause entirely. For genuinely-safe silent-swallow cases
          // (e.g. `localStorage` unavailable), use an eslint-disable
          // with a one-line rationale so the exception is reviewed.
          selector: "CatchClause > BlockStatement[body.length=0]",
          message:
            "Silent catch {} is forbidden. Either rethrow with `{ cause: err }`, or call captureException + log.error and emit an outcome metric (see docs/DETERMINISM_AUDIT §3.1).",
        },
        {
          // Error wrapping via string concatenation with a `.message`
          // access: `new Error("x: " + e.message)` loses the original
          // `.cause` chain. Use the native `cause` constructor option
          // instead. We only match the `.message` form — plain string
          // concatenation for constant messages doesn't apply.
          selector:
            "NewExpression[callee.name='Error'] BinaryExpression[operator='+'] MemberExpression[property.name='message']",
          message:
            "Do not wrap errors by concatenating `err.message`. Use `new Error('msg', { cause: err })` so `.cause` survives (see docs/DETERMINISM_AUDIT §3.1).",
        },
        {
          // Parallel `_FAILURE` / `_TIMEOUT` / `_RETRY` metric constants
          // violate the "one name per logical event" schema. Use
          // `m.count(<base>, { outcome: "error" | "timeout" })` instead.
          selector:
            "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name=/_(FAILURE|TIMEOUT|RETRY|RETRIES)$/]",
          message:
            "Parallel _FAILURE / _TIMEOUT / _RETRY metric constants are forbidden. Use one name + `{ outcome, reason }` (see docs/DETERMINISM_AUDIT §3.4).",
        },
      ],
    },
  },
  {
    // Only the logging + metrics entry points may call `console.*`
    // directly. Everywhere else must go through `log.*` so DEBUG
    // gating + Sentry breadcrumb wiring applies uniformly.
    files: [
      "**/src/**/*.ts",
      "**/src/**/*.tsx",
    ],
    ignores: [
      "**/packages/shared/src/log.ts",
      "**/packages/metrics/src/**",
      "**/apps/sandbox/src/app-sw.ts",
    ],
    rules: {
      "no-console": "error",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "*.js", "*.cjs"],
  },
];
