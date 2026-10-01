// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A leaf of its own: the host's eager protocol client needs only this value,
// and importing it from the broker would pull the whole broker into that chunk.

/**
 * The `error.data` of an answer to a request the chain halted under. The chain
 * is rebuilt on the next connect, so a client that sees it may retry there.
 */
export const CHAIN_HALTED_ERROR_DATA = 'dotli:chain-halted';
