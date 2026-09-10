// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-method request budgets for the protocol client.
 *
 * Separate from `client.ts` so a consumer can read a budget outside a browser.
 * `client.ts` pulls in the `config` barrel, which reads `self.location` at
 * module load.
 */

import type { ProtocolRequestMethod } from "./messages";

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Methods whose completion time depends on chain sync or user patience.
 *
 * No per-request timeout. A smoldot panic emits a `fatal` envelope that
 * rejects pending requests, and the user can abandon via the "Change
 * settings" affordance. Waiting longer than 5 min is fine. Silently
 * killing the request is not.
 */
export const UNTIMED_METHODS: ReadonlySet<ProtocolRequestMethod> =
  new Set<ProtocolRequestMethod>(["warmup"]);

/**
 * Budget per method, in ms.
 *
 * A caller stamps `deadlineMs` from this, and the handler derives its own sync
 * budget from that deadline, so tests should read these values rather than
 * restating the arithmetic.
 */
export const METHOD_TIMEOUTS: Partial<Record<ProtocolRequestMethod, number>> = {
  chainConnect: 30_000,
  resolveDotName: 90_000,
  resolveOwner: 90_000,
  resolveExecutableManifest: 30_000,
  resolveRootManifest: 30_000,
};
