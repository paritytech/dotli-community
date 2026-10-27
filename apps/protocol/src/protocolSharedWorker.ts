// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Runs smoldot in-thread because SharedWorkerGlobalScope has no `Worker` constructor. Every tab's protocol iframe
// shares this one light client over a MessagePort.

/// <reference lib="webworker" />
declare const self: SharedWorkerGlobalScope;

import { isLocalhost, setActiveNetwork } from '@dotli/config';
import { flushTelemetry, initSentry, installGlobalErrorHandlers, m } from '@dotli/metrics';
import { byteMeter, chainSync, createLightClient, createLightClientDeps } from '@dotli/chains';
import { createDotnsResolver } from '@dotli/resolver';

import { startProtocolWorker, workerNetwork } from './protocolWorker.js';

initSentry('worker');
installGlobalErrorHandlers('worker');
// Tagged so broker and smoldot counters aggregate with the iframe's.
m.setDefaults({ protocol_mode: 'shared-worker' });

const network = workerNetwork(self.name);
if (network.success) {
  // Before the light client starts, since everything in this worker reads the active network.
  setActiveNetwork(network.value);
  m.setDefaults({ network: network.value });
}

// Before the light client starts, or its first sockets go uncounted.
byteMeter.install();

startProtocolWorker({
  scope: self,
  network,
  flush: () => flushTelemetry(2_000),
  netBytes: { read: byteMeter.readBytesReceived },
  // A worker has no session to tune it from.
  lightClient: createLightClient(createLightClientDeps(null, isLocalhost)),
  // The resolver's factory by name, not its namespace, so the worker bundle keeps only what it calls of the resolver.
  resolver: {
    createDotnsResolver,
    enableSyncReporting: chainSync.enableSyncReporting,
    onChainDetail: chainSync.onChainDetail,
    onChainSync: chainSync.onChainSync,
  },
});
