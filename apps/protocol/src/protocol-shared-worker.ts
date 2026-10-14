// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Runs smoldot in-thread because SharedWorkerGlobalScope has no `Worker` constructor. Every tab's protocol iframe
// shares this one light client over a MessagePort.

/// <reference lib="webworker" />
declare const self: SharedWorkerGlobalScope;

import { isLocalhost, setActiveNetwork } from '@dotli/config';
import { initSentry, installGlobalErrorHandlers, m } from '@dotli/metrics';
import { createLightClient, enableSyncReporting, lightClientDeps, onChainDetail, onChainSync } from '@dotli/chains';
import { createDotnsResolver } from '@dotli/resolver';

import { startProtocolWorker, workerNetwork } from './protocol-worker.js';

initSentry('worker');
installGlobalErrorHandlers('worker');
// Tagged so broker and smoldot counters aggregate with the iframe's.
m.setDefaults({ protocol_mode: 'shared-worker' });

const network = workerNetwork(self.name);
if (network.ok) {
  // Before the light client starts, since everything in this worker reads the active network.
  setActiveNetwork(network.network);
  m.setDefaults({ network: network.network });
}

startProtocolWorker({
  scope: self,
  network,
  // A worker has no session to tune it from.
  lightClient: createLightClient(lightClientDeps(null, isLocalhost)),
  // The functions, not the namespace, so the worker bundle keeps only what it calls.
  resolver: {
    createDotnsResolver,
    enableSyncReporting,
    onChainDetail,
    onChainSync,
  },
});
