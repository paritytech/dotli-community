// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product's worker executable. The last answer is kept per network and label, so a warm load starts its worker
// off a dotNS read. The same label can name another product on another network.

import { getNetwork, type Network } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import { isRecord, pageLocalStorage, type SafeStorage } from '@dotli/shared';
import type { NameSource, WorkerExecutable } from './createNameSource.js';

const report = createReporter({ flow: 'resolve' });

/**
 * Count. The worker executable read failed, so the load goes on with the kept answer, or with no worker.
 * Tagged `outcome` (error) and `reason` (the error's name). Named before the read served the worker, and dashboards
 * read the name.
 */
const workerExecutableMetric = defineCount<'error'>('chat.capability');

/** Keeps the last answer per network and label for the next load. */
export type ExecutableCache = ReturnType<typeof createStorageExecutableCache>;

/** A kept answer: the label's worker, or null for a label that publishes none. */
type KeptExecutable = { executable: WorkerExecutable | null };

type ReadWorkerExecutableParams = {
  /** Where the last answer is kept, the page's local storage by default. */
  cache?: ExecutableCache | undefined;
  /** The network the page resolves names on, the active one by default. */
  network?: Network | undefined;
};

type CreateStorageExecutableCacheParams = {
  /** Where the answers are kept. */
  storage: Pick<SafeStorage, 'getItem' | 'setItem'>;
};

/**
 * Resolves `label`'s worker executable on `network`: the answer kept for that network when there is one, so it never
 * waits on the read, else what `names` reads. The read refreshes the kept answer for the next load either way. A failed
 * read means no worker for this load and leaves the kept answer as it was.
 */
export function readWorkerExecutable(
  label: string,
  names: Pick<NameSource, 'readWorkerExecutable'>,
  {
    cache = createStorageExecutableCache({ storage: pageLocalStorage }),
    network = getNetwork(),
  }: ReadWorkerExecutableParams = {},
): Promise<WorkerExecutable | null> {
  const kept = cache.get(label, network);
  const fresh = names.readWorkerExecutable(label).then(
    executable => {
      cache.set(label, network, executable);
      return executable;
    },
    (error: unknown) => {
      report.expected(error, {
        step: 'worker_executable_read',
        metric: workerExecutableMetric,
        message: '[dot.li resolve] worker executable unreadable, the load goes on with the kept answer or none:',
      });
      return null;
    },
  );
  return kept === null ? fresh : Promise.resolve(kept.executable);
}

/** Builds a cache in `storage`. */
export function createStorageExecutableCache({ storage }: CreateStorageExecutableCacheParams) {
  return {
    /** Returns the answer kept for `label` on `network`, or null when none is kept or it is unreadable. */
    get,
    /** Keeps `executable` as the answer for `label` on `network`. */
    set(label: string, network: Network, executable: WorkerExecutable | null): void {
      storage.setItem(getKey(label, network), JSON.stringify(executable));
    },
  };

  function get(label: string, network: Network): KeptExecutable | null {
    const raw = storage.getItem(getKey(label, network));
    if (raw === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt entry keeps no answer, so the load waits on the read, which writes a good one.
      return null;
    }
    if (parsed === null) {
      return { executable: null };
    }
    return isWorkerExecutable(parsed) ? { executable: parsed } : null;
  }
}

function getKey(label: string, network: Network): string {
  return `dotli:worker-executable:${network}:${label}`;
}

function isWorkerExecutable(value: unknown): value is WorkerExecutable {
  return (
    isRecord(value) &&
    typeof value['entrypoint'] === 'string' &&
    typeof value['cid'] === 'string' &&
    isRecord(value['includes'])
  );
}
