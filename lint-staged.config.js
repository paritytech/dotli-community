// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One key, so formatting finishes before linting starts. Turbo's `[HEAD]` filter lints each changed workspace (and
// the root, via `lint:root`) whole with its own config. Dependents are left to CI.

export default {
  /** @param {readonly string[]} files */
  '*': files => [
    `prettier --write --ignore-unknown ${files.map(file => JSON.stringify(file)).join(' ')}`,
    'turbo run lint lint:root --filter=[HEAD] --output-logs=errors-only',
  ],
};
