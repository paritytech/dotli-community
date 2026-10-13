// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The network as the chains views read it. Callers pass wider values, which fit structurally.

import type { ChainRole } from '@dotli/config';
import type { ChainSummary } from '@dotli/ui-entities';
import type { LiveVerdict } from '../../network-verdict.js';

export interface ChainView extends ChainSummary {
  /** The role of a known chain, the genesis hash of any other. */
  readonly key: string;
  /** Null for a chain outside the known roles, which the panel lists under Other chains. */
  readonly role: ChainRole | null;
  /** Since the chain's last block, as of `NetworkView.readAt`. Null before any. */
  readonly sinceLast: number | null;
}

export interface TransferView {
  readonly bytesPerSecond: number | null;
  /** Bytes of the product archive fetched so far. */
  readonly fetched: number | null;
  /** Null on a load served from cache. */
  readonly total: number | null;
}

export interface NetworkView {
  readonly chains: readonly ChainView[];
  readonly transfer: TransferView;
  /** When `chains` was read, so a countdown adds the time since to each `sinceLast`. */
  readonly readAt: number;
  readonly verdict: LiveVerdict;
}
