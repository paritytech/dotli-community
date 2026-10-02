// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lints the packages a commit touches. lint-staged hides unstaged edits while
// this runs, and turbo's `[HEAD]` filter picks every workspace (and the root,
// for `lint:root`) with changes against HEAD, so each changed package is
// linted whole, with its own config. Dependents are not linted; CI lints
// everything.
export default {
  '*': () => 'turbo run lint lint:root --filter=[HEAD] --output-logs=errors-only',
};
