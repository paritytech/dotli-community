// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each chain mode loads its chains on demand, so the frame's first load carries neither the chain pool nor a
// transport, and the shared-worker mode, which only relays, loads none.

import type * as GatewayChainsNamespace from './openGatewayChains.js';
import type * as LightClientServiceNamespace from './startLightClientService.js';

export type GatewayChainsModule = typeof GatewayChainsNamespace;
export type LightClientServiceModule = typeof LightClientServiceNamespace;

/** Loads gateway mode's chains. Rejects when the chunk fails to load. */
export function loadGatewayChains(): Promise<GatewayChainsModule> {
  return import('./openGatewayChains.js');
}

/** Loads the light client service of direct mode. Rejects when the chunk fails to load. */
export function loadLightClientService(): Promise<LightClientServiceModule> {
  return import('./startLightClientService.js');
}
