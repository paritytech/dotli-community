// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// smoldot-direct runs smoldot in the protocol iframe, smoldot-shared-worker in a SharedWorker that tabs share.
// rpc-gateway uses a trusted JSON-RPC node and an IPFS gateway, with no smoldot.

import { activeSettings } from './activeSettings.js';

export type Backend = 'smoldot-direct' | 'smoldot-shared-worker' | 'rpc-gateway';

type BackendFacts = {
  /** The label the Settings control shows. Copy that names the control quotes it from here. */
  label: string;
  /** Runs a light client, so chains and content are verified and fetched over peers. */
  lightClient: boolean;
  /** Runs its light client in a SharedWorker that tabs share. */
  sharedWorker: boolean;
  /** The backend a failed load offers to switch to. */
  failover: Backend;
};

/**
 * Per-backend facts: the settings label, whether it runs a light client, whether in a SharedWorker, and the backend a
 * failed load offers instead.
 */
export const BACKEND_FACTS = {
  'smoldot-direct': { label: 'Light client per tab', lightClient: true, sharedWorker: false, failover: 'rpc-gateway' },
  'smoldot-shared-worker': {
    label: 'Light client shared',
    lightClient: true,
    sharedWorker: true,
    failover: 'rpc-gateway',
  },
  'rpc-gateway': {
    label: 'Trusted providers',
    lightClient: false,
    sharedWorker: false,
    failover: 'smoldot-shared-worker',
  },
} satisfies Record<Backend, BackendFacts>;

export const BACKEND_KEY = 'dotli:chain-backend';

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
  return hasLightClient(backend);
}

/** Whether `backend` runs a light client, so chains and content are verified and fetched over peers. Never throws. */
export function hasLightClient(backend: Backend): boolean {
  return BACKEND_FACTS[backend].lightClient;
}

/** Whether `backend` runs its light client in a SharedWorker that tabs share. Never throws. */
export function hasSharedWorker(backend: Backend): boolean {
  return BACKEND_FACTS[backend].sharedWorker;
}

function isBackend(value: string): value is Backend {
  return Object.hasOwn(BACKEND_FACTS, value);
}
