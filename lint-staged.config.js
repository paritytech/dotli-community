// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Formats the staged files, then lints the packages a commit touches.
// lint-staged hides unstaged edits while this runs and stages what Prettier
// rewrites. Turbo's `[HEAD]` filter then picks every workspace (and the root,
// for `lint:root`) with changes against HEAD, so each changed package is
// linted whole, with its own config. Dependents are not linted; CI lints
// everything. One key, so the formatting finishes before the lint starts.

// The extensions `npm run format:check` covers.
const FORMATTED = /\.(ts|tsx|js|mjs|json|md|astro)$/;

export default {
  /** @param {readonly string[]} files */
  '*': files => {
    const formatted = files.filter(file => FORMATTED.test(file)).map(file => JSON.stringify(file));
    return [
      ...(formatted.length > 0 ? [`prettier --write ${formatted.join(' ')}`] : []),
      'turbo run lint lint:root --filter=[HEAD] --output-logs=errors-only',
    ];
  },
};
