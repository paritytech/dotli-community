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

const tsExtensionImport = {
  regex: '^\\.{1,2}/.*\\.tsx?$',
  message: 'Import the `.js` path. Only files Node loads directly, such as vite.config.ts, use `.ts`.',
};

const testOnlyMessage = 'Test-only. Import it from specs and tests, never from shipped code.';

// A package's `./testing` entry and its sub-paths, such as `@dotli/metrics/testing/setup`.
const testingEntryImport = { regex: '^@dotli/[^/]+/testing(/.*)?$', message: testOnlyMessage };

const testOnlyModuleImport = {
  regex: '^\\.{1,2}/(.*/)?(testing/.*|[^/]+\\.(spec|fake))(\\.js)?$',
  message: testOnlyMessage,
};

// What shipped code may not import.
const shippedImportPatterns = [tsExtensionImport, testingEntryImport, testOnlyModuleImport];

// Unit specs, the fake of one module beside it, and shared fixtures. Globs match from each package's own config.
const testOnlyFiles = [
  '**/src/**/*.spec.ts',
  '**/src/**/*.spec.tsx',
  '**/src/**/*.fake.ts',
  '**/src/testing/**/*.ts',
  '**/src/testing/**/*.tsx',
];

// Shared fixtures that drive a page, which functional tests run under happy-dom and story plays in a real browser.
const domTestingFiles = ['**/src/testing/**/*.dom.ts', '**/src/testing/**/*.dom.tsx'];

const storyFiles = ['**/src/**/*.stories.tsx'];

const storyImportPatterns = [tsExtensionImport, testOnlyModuleImport];

const noDomMessage =
  'Unit specs run under Node with no DOM. Test a component with a story play, or DOM wiring with a functional test in tests/.';

const domToolingImports = {
  patterns: [
    tsExtensionImport,
    {
      group: [
        'happy-dom',
        'happy-dom/*',
        '@happy-dom/*',
        'jsdom',
        'jsdom/*',
        '@testing-library/*',
        '@solidjs/testing-library',
      ],
      message: noDomMessage,
    },
  ],
};

const domGlobals = [
  'document',
  'window',
  'self',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'matchMedia',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'ResizeObserver',
  'MutationObserver',
  'IntersectionObserver',
  'customElements',
  'HTMLElement',
];

/**
 * The syntax every package refuses. A package that adds its own `no-restricted-syntax` selectors spreads these first,
 * since its rule replaces this one.
 */
export const restrictedSyntax = [
  {
    // A genuinely safe swallow takes an eslint-disable with a one-line reason, so it gets reviewed.
    selector: 'CatchClause > BlockStatement[body.length=0]',
    message:
      'Silent catch {} is forbidden. Either rethrow with `{ cause: err }`, or call captureException + log.error and emit an outcome metric.',
  },
  {
    selector:
      "NewExpression[callee.name='Error'] BinaryExpression[operator='+'] MemberExpression[property.name='message']",
    message:
      "Do not wrap errors by concatenating `err.message`. Use `new Error('msg', { cause: err })` so `.cause` survives.",
  },
  {
    selector:
      'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name=/_(FAILURE|TIMEOUT|RETRY|RETRIES)$/]',
    message:
      'Parallel _FAILURE / _TIMEOUT / _RETRY metric constants are forbidden. Use one name + `{ outcome, reason }`.',
  },
];

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
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
      curly: ['error', 'all'],

      'no-restricted-syntax': ['error', ...restrictedSyntax],
    },
  },
  {
    // `allowImportingTsExtensions` is on for the files Node loads directly, so tsc alone would not catch a stray `.ts`.
    rules: {
      'no-restricted-imports': ['error', { patterns: [tsExtensionImport] }],
    },
  },
  {
    // Shipped code never reaches test-only modules. The recorder replaces the bound Sentry, so shipped code that
    // reached it would drop every metric.
    files: ['**/src/**/*.ts', '**/src/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: shippedImportPatterns,
        },
      ],
    },
  },
  {
    // Stories never ship and their plays are tests, so they may reach `./testing` entries such as the store reset.
    files: storyFiles,
    rules: {
      'no-restricted-imports': ['error', { patterns: storyImportPatterns }],
    },
  },
  {
    files: ['**/vite.config.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // Shipped code logs through `log.*`, so DEBUG gating and Sentry breadcrumbs apply. Build scripts and configs may
    // still warn or fail to the terminal.
    ignores: ['**/src/**'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
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
    // Test-only files in src get the test relaxations, may import `./testing` entries, and refuse DOM tooling.
    files: testOnlyFiles,
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      'no-restricted-imports': ['error', domToolingImports],
      'no-restricted-globals': ['error', ...domGlobals.map(name => ({ name, message: noDomMessage }))],
      // `globalThis.document` reaches the same globals past the rule above.
      'no-restricted-properties': [
        'error',
        ...domGlobals.map(property => ({ object: 'globalThis', property, message: noDomMessage })),
      ],
    },
  },
  {
    // No unit spec runs these, so they may read the DOM. A spec that called one would fail under Node.
    files: domTestingFiles,
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
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

/**
 * What a file that never sees the runtime network config may import from `@dotli/config`: readers of the fields no
 * override can change, and values that do not depend on the network config at all. A new name joins only once it
 * reads no overridable field, directly or through a helper.
 */
const fixedConfigSurface = [
  'CHAIN_ROLES',
  'ChainRole',
  'DEBUG',
  'FixedServicesConfig',
  'Network',
  'chainRoleForGenesis',
  'getActiveFixedServicesConfig',
  'getActiveSupportedGenesisHashes',
  'isValidNetwork',
];

/**
 * For files that run where the runtime network config never arrives, such as the protocol worker, which serves every
 * tab. They import only the fixed config surface, so no reader that applies the overrides reaches them. The files
 * match relative to the package's own config, so the package spreads this after `config`.
 *
 * @param {string[]} files
 */
export function fixedServicesConfigOnly(files) {
  return defineConfig([
    {
      files,
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: '@dotli/config',
                allowImportNames: fixedConfigSurface,
                message:
                  'Import only the fixed config surface (fixedConfigSurface in @config/eslint/vite). The runtime config never reaches this file, so a reader of the overridable fields would miss its overrides.',
              },
            ],
            patterns: shippedImportPatterns,
          },
        ],
      },
    },
  ]);
}

/**
 * A `no-restricted-syntax` entry that refuses `import()` of a module whose name matches `pattern`, which
 * `no-restricted-imports` never checks. The selector syntax ends a regex at its first `/`, so `pattern` matches a
 * scope's slash with `.` instead. A package spreads `restrictedSyntax` first, since its rule replaces the base one.
 *
 * @param {string} pattern
 * @param {string} message
 * @returns {{ selector: string, message: string }}
 */
export function dynamicImportBan(pattern, message) {
  if (pattern.includes('/')) {
    throw new Error(`dynamicImportBan: write the slash in ${pattern} as "."`);
  }
  return { selector: `ImportExpression[source.value=/${pattern}/]`, message };
}

/**
 * A ban for `importBans` that refuses every `@dotli/*`, `@config/*` and `@parity/*` import but the `allowed`
 * packages, so a package's layer is the list it may import. An allowed package keeps its subpaths, such as `/testing`.
 *
 * @param {string[]} allowed
 * @param {string} message
 * @returns {{ group: string[], message: string }}
 */
export function onlyAllowedScopes(allowed, message) {
  return {
    group: ['@dotli/*', '@config/*', '@parity/*', ...allowed.map(name => `!${name}`)],
    message,
  };
}

/**
 * Bans imports that cross a package's layer, on top of what `config` bans. Each ban is a gitignore-style `group` of
 * import paths, or a `regex` of them, with the reason as its `message`. With `allowImportNames`, the ban refuses only
 * the other names imported from a matching path. The files match relative to the package's own config, so the package
 * spreads this after `config`. With `within`, the bans hold only in files that also match one of its globs. Spread after
 * the package's own bans, a zone repeats them, since the zone's rule replaces theirs.
 *
 * @param {(({ group: string[] } | { regex: string }) & { message: string, allowImportNames?: string[] })[]} bans
 * @param {string[]} [within]
 */
export function importBans(bans, within) {
  const directLoads = ['**/vite.config.ts'];
  /** @param {string[]} globs */
  const scoped = globs => (within === undefined ? globs : globs.flatMap(glob => within.map(zone => [glob, zone])));
  return defineConfig([
    {
      files: scoped(['**/*.ts', '**/*.tsx', '**/*.js']),
      ignores: directLoads,
      rules: {
        'no-restricted-imports': ['error', { patterns: [tsExtensionImport, ...bans] }],
      },
    },
    {
      files: scoped(['**/src/**/*.ts', '**/src/**/*.tsx']),
      ignores: directLoads,
      rules: {
        'no-restricted-imports': ['error', { patterns: [...shippedImportPatterns, ...bans] }],
      },
    },
    {
      files: scoped(storyFiles),
      rules: {
        'no-restricted-imports': ['error', { patterns: [...storyImportPatterns, ...bans] }],
      },
    },
    {
      files: scoped(testOnlyFiles),
      rules: {
        'no-restricted-imports': ['error', { patterns: [...domToolingImports.patterns, ...bans] }],
      },
    },
  ]);
}
