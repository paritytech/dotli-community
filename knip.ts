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
      // The pages load these through `<script src>`. The PWA integration builds the service worker. `sentryCheck.ts`
      // is a manual CLI check. The functional suite's global setup bundles the `wire` scripts for its pages. The Astro
      // plugin takes the first `srcDir` in the Astro config as the pages' root, which is the service worker's, so the
      // pages are named here.
      entry: [
        'src/pages/**/*.astro',
        'src/shell/main.ts',
        'src/shell/landing.ts',
        'src/shell/session.ts',
        'src/shell/host-sw.ts',
        'sentryCheck.ts',
        'tests/functional/wire/*.ts',
      ],
    },
    'apps/sandbox': {
      // The service worker is the PWA plugin's source, named in vite.config.ts.
      entry: ['src/serviceWorker/app-sw.ts'],
    },
  },
} satisfies KnipConfig;
