// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's own chunk, loaded only in debug mode. It lives apart from index.ts so the barrel stays pure re-exports.

import type * as TruapiDebugMountNamespace from './truapi-debug-panel.js';

export type TruapiDebugMountModule = typeof TruapiDebugMountNamespace;
export const loadTruapiDebugMount = (): Promise<TruapiDebugMountModule> => import('./truapi-debug-panel.js');
