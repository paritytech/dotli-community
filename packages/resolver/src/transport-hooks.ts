// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/** `onHalt` means the transport is gone for good. A self-recovering one, such as WebSocket, never halts. */
export interface ChainTransportHooks {
  onStatus: (status: ConnectionStatus) => void;
  onHalt: (error?: unknown) => void;
}
