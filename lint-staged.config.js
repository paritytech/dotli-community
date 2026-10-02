// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Formats the staged files, then lints the packages a commit touches.
// lint-staged hides unstaged edits while this runs and stages what Prettier
// rewrites; `--ignore-unknown` skips files Prettier has no parser for. Turbo's
// `[HEAD]` filter then picks every workspace (and the root, for `lint:root`)
// with changes against HEAD, so each changed package is linted whole, with
// its own config. Dependents are not linted; CI lints everything. One key, so
// the formatting finishes before the lint starts.

export default {
  /** @param {readonly string[]} files */
  '*': files => [
    `prettier --write --ignore-unknown ${files.map(file => JSON.stringify(file)).join(' ')}`,
    'turbo run lint lint:root --filter=[HEAD] --output-logs=errors-only',
  ],
};
