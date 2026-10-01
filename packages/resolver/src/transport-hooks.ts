// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A chain transport's connection state, as the chain pool tracks it. */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * What a chain transport reports to the pool that owns it. `onStatus` follows
 * the connection. `onHalt` means the transport is gone for good and its
 * consumers must be told. A transport that recovers on its own, as the
 * WebSocket one does, never halts.
 */
export interface ChainTransportHooks {
  onStatus: (status: ConnectionStatus) => void;
  onHalt: (error?: unknown) => void;
}
