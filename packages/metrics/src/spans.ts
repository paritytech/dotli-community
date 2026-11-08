// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The metric names more than one package reads, without the `dotli.` prefix the metrics API adds.

export const spans = {
  /** Create, relay, asset hub and first finalized block together. */
  SMOLDOT_PRESYNC: 'smoldot.presync',

  /** A lazy chunk a caller could not load and went on without. Tagged `outcome` and `reason` (the caller's step). */
  LAZY_CHUNK_LOAD: 'lazy_chunk.load',

  /**
   * One flush of buffered telemetry before a context closes. Counted only when the flush threw, tagged `outcome` and
   * `reason` (the error's name).
   */
  TELEMETRY_FLUSH: 'telemetry.flush',
} as const;
