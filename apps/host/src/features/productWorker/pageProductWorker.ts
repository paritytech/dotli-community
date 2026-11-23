// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page product's worker over the page's own core, prompts, grants and content. Loaded once the product is first
// done, so the VM's client, the fetch gate and the archive reader stay out of the boot and bridge chunks.

import { createQuickJsWorker, type ModuleFiles } from '@dotli/quickjs-runtime';
import QuickJsWorker from '@dotli/quickjs-runtime/worker?worker';
import { createHostFetchGate } from '../permissions/index.js';
import { readServedArchive, readWorkerExecutable, type NameSource } from '../productLoad/index.js';
import type { HostBridge } from '../productRuntime/index.js';
import { startProductWorker } from './startProductWorker.js';

export type PageProductWorkerParams = {
  /** The page's product. */
  label: string;
  /** The name source the load reads with, so the worker's executable read is the load's. */
  names: Pick<NameSource, 'readWorkerExecutable'>;
  /** The loaded bridge, initialised: its page core, its prompt queue and its bitswap client. */
  bridge: Pick<HostBridge, 'acquirePageCore' | 'createModalScope' | 'hostBitswapClient'>;
};

/**
 * Starts the worker of the page's product on the page core's ledger, with the page's reference on it. Returns the stop.
 */
export function startPageProductWorker({ label, names, bridge }: PageProductWorkerParams): () => void {
  return startProductWorker({
    label,
    core: { acquire: bridge.acquirePageCore },
    readExecutable: name => readWorkerExecutable(name, names),
    readFiles: async cid => {
      const files = await readServedArchive(cid, bridge.hostBitswapClient);
      return new Map(Object.entries(files)) satisfies ModuleFiles;
    },
    openGate: () => {
      const scope = bridge.createModalScope();
      const gate = createHostFetchGate({ label, scope });
      return {
        isHostAllowed: host => gate.isHostAllowed(host),
        dispose: () => {
          scope.dispose();
        },
      };
    },
    startVm: params =>
      createQuickJsWorker({
        ...params,
        createWorker: () => new QuickJsWorker(),
      }),
  });
}
