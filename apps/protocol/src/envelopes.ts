// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The frame's telemetry as the host hears it, built once for the iframe and the SharedWorker that serves every tab.
// Typed from the wire contract, so a change there fails the build here.

import type { ChainDetail, ChainSyncEvent, SmoldotDbChain, SmoldotDbOutcome } from '@dotli/chains';
import type { TelemetryEvent } from '@dotli/protocol';

export function chainSyncTelemetry(event: ChainSyncEvent): TelemetryEvent {
  return { tag: 'chainSync', value: event };
}

export function chainDetailTelemetry(detail: ChainDetail): TelemetryEvent {
  return { tag: 'chainDetail', value: detail };
}

export function smoldotDbTelemetry(chain: SmoldotDbChain, outcome: SmoldotDbOutcome): TelemetryEvent {
  return { tag: 'smoldotDb', value: { chain, outcome } };
}

export function netBytesTelemetry(total: number): TelemetryEvent {
  return { tag: 'netBytes', value: total };
}
