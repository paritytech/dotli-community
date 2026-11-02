// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// smoldot-direct runs smoldot in the protocol iframe, smoldot-shared-worker in a SharedWorker that tabs share.
// rpc-gateway uses a trusted JSON-RPC node and an IPFS gateway, with no smoldot.

import { activeSettings } from './activeSettings.js';

export type Backend = 'smoldot-direct' | 'smoldot-shared-worker' | 'rpc-gateway';

/** Settings panel labels. Here rather than in the topbar because error copy names these controls, and copies drift. */
export const BACKEND_LABELS: Record<Backend, string> = {
  'smoldot-direct': 'Light client per tab',
  'smoldot-shared-worker': 'Light client shared',
  'rpc-gateway': 'Trusted providers',
};

export const BACKEND_KEY = 'dotli:chain-backend';

const VALID_BACKENDS: ReadonlySet<string> = new Set<Backend>([
  'smoldot-direct',
  'smoldot-shared-worker',
  'rpc-gateway',
]);

/** A backend as written in storage, the link or the sandbox's URL, or null when it names none this build knows. */
export function parseBackend(raw: string | null): Backend | null {
  return raw !== null && isBackend(raw) ? raw : null;
}

/** This context's backend, or the default before boot sets the settings. */
export function getBackend(): Backend {
  return activeSettings()?.backend ?? getDefaultBackend();
}

/** The backend a visitor starts on. */
export function getDefaultBackend(): Backend {
  return 'smoldot-direct';
}

/** Verified means smoldot end to end. rpc-gateway trusts operators for chain access and content. */
export function isVerifiedSession(backend: Backend): boolean {
  return backend !== 'rpc-gateway';
}

function isBackend(value: string): value is Backend {
  return VALID_BACKENDS.has(value);
}
