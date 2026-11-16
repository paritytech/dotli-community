// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points for packages, each its own chunk, so the page boot leaves them out.

import type * as HostWebNamespace from '@parity/truapi-host/web';
import type * as HostWorkerNamespace from '@parity/truapi-host/worker-runtime?worker';
import type * as PolkadotApiNamespace from 'polkadot-api';
import type * as QrCodeNamespace from 'qrcode';
import type * as SignersCommonNamespace from '@polkadot-api/signers-common';

/** The published host runtime's chunk: its web build and the constructor of its worker. */
type HostRuntimeChunk = {
  web: typeof HostWebNamespace;
  HostWorker: typeof HostWorkerNamespace.default;
};

/** `qrcode` is CommonJS, so its dynamic import also carries the whole module as `default`. */
type QrCodeModule = typeof QrCodeNamespace & { default: typeof QrCodeNamespace };

/**
 * The published host runtime and its worker, which every core boots on and the product frame mounts with. Rejects
 * when either chunk fails to load.
 */
export async function loadHostRuntimeChunk(): Promise<HostRuntimeChunk> {
  const [web, worker] = await Promise.all([
    import('@parity/truapi-host/web'),
    import('@parity/truapi-host/worker-runtime?worker'),
  ]);
  return { web, HostWorker: worker.default };
}

/** The chain client, for the reads a visit may never make. Rejects when its chunk fails to load. */
export function loadPolkadotApi(): Promise<typeof PolkadotApiNamespace> {
  return import('polkadot-api');
}

/**
 * papi's transaction extension fillers, for the first transaction a site asks to sign. Rejects when its chunk fails to
 * load.
 */
export function loadTxFillers(): Promise<typeof SignersCommonNamespace> {
  return import('@polkadot-api/signers-common');
}

/** The QR encoder, for the first code a visit shows. Rejects when its chunk fails to load. */
export function loadQrCode(): Promise<QrCodeModule> {
  return import('qrcode');
}
