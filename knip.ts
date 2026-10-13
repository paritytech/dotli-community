// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Finds unused files, dependencies and exports. The plugins read each tool's config for entries, and package.json
// `exports` are the package entries. Listed here is only what they cannot see.

import type { KnipConfig } from 'knip';

export default {
  // A type that appears in an exported signature stays exported so callers can name it.
  ignoreExportsUsedInFile: { interface: true, type: true },
  'github-actions': true,
  husky: true,
  eslint: true,
  typescript: true,
  vite: true,
  vitest: true,
  turbo: true,
  workspaces: {
    '.': {
      // Node runs these from the shell or by hand, not through a package.json script.
      entry: ['scripts/*.ts'],
      // Pins one truapi version across the workspaces and is what `link:truapi` swaps for a local build.
      ignoreDependencies: ['@parity/truapi'],
    },
    'apps/host': {
      astro: true,
      playwright: true,
      // The pages load these through `<script src>`. `sentry-check.ts` is a manual CLI check.
      entry: ['src/main.ts', 'src/landing.ts', 'sentry-check.ts'],
    },
    'apps/sandbox': {
      // The service worker is a separate Vite build named in vite.config.ts. Storybook loads its own Vite config by the
      // path `.storybook/main.ts` gives it.
      entry: ['src/app-sw.ts', '.storybook/vite.config.ts'],
    },
    'config/typescript': {
      // `solid.json` names it as `jsxImportSource`, and each Solid workspace installs it.
      ignoreDependencies: ['@solidjs/web'],
    },
    'packages/metrics': {
      // The strip-analytics plugin swaps these in by resolved path.
      entry: ['src/*.noop.ts'],
      // The app installs the SDK. A metrics-stripped build replaces it with the no-op twin.
      ignoreDependencies: ['@sentry/browser'],
    },
    'packages/ui': {
      storybook: true,
    },
  },
} satisfies KnipConfig;
