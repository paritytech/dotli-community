// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each chain mode loads its chains on demand, so the frame's first load carries neither the chain pool nor a
// transport, and the shared-worker mode, which only relays, loads none.

import type * as GatewayChainsNamespace from './gateway-chains.js';
import type * as LightClientServiceNamespace from './light-client-service.js';

export type GatewayChainsModule = typeof GatewayChainsNamespace;
export type LightClientServiceModule = typeof LightClientServiceNamespace;

export const loadGatewayChains = (): Promise<GatewayChainsModule> => import('./gateway-chains.js');
export const loadLightClientService = (): Promise<LightClientServiceModule> => import('./light-client-service.js');
