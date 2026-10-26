// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Emptying the browser stores of one origin, for the resets each dotli origin offers. A part that could not finish
// rejects, so no caller reports a wipe that left data behind as done.

import { deleteIdb } from './idb.js';

/** A store an origin wipe empties, by the name its failure is counted under. */
export type OriginWipePart = 'indexeddb' | 'cache_storage' | 'service_worker';

/** The stores of one origin. A store this browser lacks is `null` and has nothing to wipe. */
export type OriginStores = {
  indexedDB: Pick<IDBFactory, 'databases' | 'deleteDatabase'> | null;
  caches: Pick<CacheStorage, 'keys' | 'delete'> | null;
  serviceWorker: Pick<ServiceWorkerContainer, 'getRegistrations'> | null;
};

/** A wipe that left parts behind, with what each of them threw. */
export class OriginWipeError extends AggregateError {
  override name = 'OriginWipeError';
  readonly failures: ReadonlyMap<OriginWipePart, unknown>;

  constructor(failures: ReadonlyMap<OriginWipePart, unknown>) {
    super([...failures.values()], `The origin wipe left ${[...failures.keys()].join(', ')} behind`);
    this.failures = failures;
  }
}

/**
 * Deletes every database but those named in `keep`, and resolves the names it deleted. Rejects when this browser
 * cannot list its databases, as older Firefox and Safari cannot, and when a delete fails or stays blocked.
 */
export async function deleteAllDatabases(
  factory: Pick<IDBFactory, 'databases' | 'deleteDatabase'>,
  keep: readonly string[] = [],
): Promise<readonly string[]> {
  if (typeof factory.databases !== 'function') {
    throw new Error('This browser cannot list its IndexedDB databases');
  }
  const names = (await factory.databases())
    .map(db => db.name)
    .filter((name): name is string => name !== undefined && name !== '' && !keep.includes(name));
  await Promise.all(names.map(name => deleteIdb(factory, name)));
  return names;
}

/**
 * Empties each store in turn, except the databases in `keepDatabases`, whatever happened to the one before, then
 * rejects with an `OriginWipeError` naming every part that failed.
 */
export async function wipeOriginStores(stores: OriginStores, keepDatabases: readonly string[] = []): Promise<void> {
  const failures = new Map<OriginWipePart, unknown>();
  const run = async (part: OriginWipePart, wipe: () => Promise<unknown>): Promise<void> => {
    try {
      await wipe();
    } catch (err) {
      failures.set(part, err);
    }
  };
  const { indexedDB: idb, caches, serviceWorker } = stores;
  if (idb !== null) {
    await run('indexeddb', () => deleteAllDatabases(idb, keepDatabases));
  }
  if (caches !== null) {
    await run('cache_storage', async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    });
  }
  if (serviceWorker !== null) {
    await run('service_worker', async () => {
      const registrations = await serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
    });
  }
  if (failures.size > 0) {
    throw new OriginWipeError(failures);
  }
}
