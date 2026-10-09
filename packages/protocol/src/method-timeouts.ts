// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Kept out of `client.ts`, whose `config` import reads `self.location` at module load,
// so a budget can be read outside a browser.

import type { ProtocolRequestMethod } from './messages.js';

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Methods bounded by chain sync or the user, not a timer. A smoldot panic rejects them through
 * a `fatal` envelope, and the user can abandon them from "Change settings".
 */
export const UNTIMED_METHODS: ReadonlySet<ProtocolRequestMethod> = new Set<ProtocolRequestMethod>(['warmup']);

/** Budget per method in ms. Handlers derive their sync budget from the stamped deadline, so tests read these values. */
export const METHOD_TIMEOUTS: Partial<Record<ProtocolRequestMethod, number>> = {
  chainConnect: 30_000,
  resolveDotName: 90_000,
  resolveOwner: 90_000,
  resolveExecutableManifest: 90_000,
  resolveRootManifest: 90_000,
  // Boot waits on it, so a protocol frame too old to answer must not hold the page for the default budget.
  localWalletRead: 5_000,
};
