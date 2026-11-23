// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product's worker executable, and whether the product declares chat, which derives from it. The product frame
// picks the connection's execution kind from chat, so the last answer is kept per network and label to keep warm loads
// off a dotNS read. The same label can name another product on another network.

import { getNetwork, type Network } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import { isRecord, pageLocalStorage, type SafeStorage } from '@dotli/shared';
import type { NameSource, WorkerExecutable } from './createNameSource.js';

const report = createReporter({ flow: 'resolve' });

/**
 * Count. The worker executable read failed, so the load goes on with the kept answer, or with no worker and no chat.
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
  storage: Pick<SafeStorage, 'getItem' | 'setItem' | 'removeItem'>;
};

// Where a chat answer was kept, by label alone, before the executable was. It answers chat until the label's first
// fresh read on any network replaces it, so a returning visitor keeps a warm load across the change. A wrong answer
// there runs no code.
const LEGACY_CHAT_PREFIX = 'dotli:chat-capable:';

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

/**
 * Whether `label` declares chat in its worker executable, answered as `readWorkerExecutable` answers. A failed read
 * means no chat for this load.
 */
export function readChatCapability(
  label: string,
  names: Pick<NameSource, 'readWorkerExecutable'>,
  {
    cache = createStorageExecutableCache({ storage: pageLocalStorage }),
    network = getNetwork(),
  }: ReadWorkerExecutableParams = {},
): Promise<boolean> {
  const kept = cache.getChat(label, network);
  const fresh = readWorkerExecutable(label, names, { cache, network }).then(
    executable => executable?.includes.chat === true,
  );
  return kept === null ? fresh : Promise.resolve(kept);
}

/** Builds a cache in `storage`. */
export function createStorageExecutableCache({ storage }: CreateStorageExecutableCacheParams) {
  return {
    /** Returns the answer kept for `label` on `network`, or null when none is kept or it is unreadable. */
    get,
    /** Returns the chat answer kept for `label` on `network`, or null when none is kept. */
    getChat(label: string, network: Network): boolean | null {
      const kept = get(label, network);
      if (kept !== null) {
        return kept.executable?.includes.chat === true;
      }
      const legacy = storage.getItem(`${LEGACY_CHAT_PREFIX}${label}`);
      return legacy === null ? null : legacy === '1';
    },
    /** Keeps `executable` as the answer for `label` on `network`. */
    set(label: string, network: Network, executable: WorkerExecutable | null): void {
      storage.setItem(getKey(label, network), JSON.stringify(executable));
      storage.removeItem(`${LEGACY_CHAT_PREFIX}${label}`);
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
