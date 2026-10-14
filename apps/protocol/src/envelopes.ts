// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The frame's telemetry as the host hears it, built once for both transports: this iframe in direct mode and the
// SharedWorker that serves every tab. Types only from the wire contract, so a change there fails the build here.

import type { ChainDetail, ChainSyncEvent } from '@dotli/chains';
import type { ProtocolEnvelope } from '@dotli/protocol';

export function chainSyncEnvelope(event: ChainSyncEvent): Extract<ProtocolEnvelope, { kind: 'chain-sync' }> {
  const { chain, kind, ...rest } = event;
  return { namespace: 'dotli:protocol', kind: 'chain-sync', chain, syncKind: kind, ...rest };
}

export function chainDetailEnvelope(detail: ChainDetail): Extract<ProtocolEnvelope, { kind: 'chain-detail' }> {
  return { namespace: 'dotli:protocol', kind: 'chain-detail', ...detail };
}
