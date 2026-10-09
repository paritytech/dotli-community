// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import solid from 'eslint-plugin-solid';
import turboPlugin from 'eslint-plugin-turbo';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

// eslint-plugin-solid types its rules against the ESLint 8 rule API, which
// ESLint 10's `Plugin` type rejects. The rules themselves run under ESLint 10.
const solidPlugin = /** @type {import("eslint").ESLint.Plugin} */ (/** @type {unknown} */ (solid));

export const config = defineConfig([
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      'turbo/no-undeclared-env-vars': 'warn',
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
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
      curly: ['error', 'all'],

      'no-restricted-syntax': [
        'error',
        {
          // A genuinely safe swallow takes an eslint-disable with a one-line reason, so it gets reviewed.
          selector: 'CatchClause > BlockStatement[body.length=0]',
          message:
            'Silent catch {} is forbidden. Either rethrow with `{ cause: err }`, or call captureException + log.error and emit an outcome metric (see docs/DETERMINISM_AUDIT §3.1).',
        },
        {
          selector:
            "NewExpression[callee.name='Error'] BinaryExpression[operator='+'] MemberExpression[property.name='message']",
          message:
            "Do not wrap errors by concatenating `err.message`. Use `new Error('msg', { cause: err })` so `.cause` survives (see docs/DETERMINISM_AUDIT §3.1).",
        },
        {
          selector:
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name=/_(FAILURE|TIMEOUT|RETRY|RETRIES)$/]',
          message:
            'Parallel _FAILURE / _TIMEOUT / _RETRY metric constants are forbidden. Use one name + `{ outcome, reason }` (see docs/DETERMINISM_AUDIT §3.4).',
        },
      ],
    },
  },
  {
    // `allowImportingTsExtensions` is on for the files Node loads directly, so tsc alone would not catch a stray `.ts`.
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.{1,2}/.*\\.tsx?$',
              message: 'Import the `.js` path. Only files Node loads directly (vite.config.ts, src/vite.ts) use `.ts`.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/vite.config.ts', '**/src/vite.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // Everything else logs through `log.*`, so DEBUG gating and Sentry breadcrumbs apply.
    files: ['**/src/**/*.ts', '**/src/**/*.tsx'],
    ignores: ['**/packages/shared/src/log.ts', '**/packages/metrics/src/**', '**/apps/sandbox/src/app-sw.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Test doubles and best-effort Playwright steps are deliberate no-ops.
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    // `.astro` holds the types Astro generates for a site (apps/host).
    ignores: ['dist/**', 'node_modules/**', '.astro/**'],
  },
  {
    files: ['**/*.tsx'],
    plugins: { solid: solidPlugin },
    rules: {
      ...solid.configs['flat/typescript'].rules,
    },
  },
]);
