// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Kept apart from index.ts so the barrel stays pure re-exports, which rolldown's lazy barrel
// optimization needs to leave unused re-exports out of an importer's chunk.

import type * as DotliDebugBusNamespace from './dotli-debug-bus.js';

export type DotliDebugBusModule = typeof DotliDebugBusNamespace;
export const loadDotliDebugBus = (): Promise<DotliDebugBusModule> => import('./dotli-debug-bus.js');
