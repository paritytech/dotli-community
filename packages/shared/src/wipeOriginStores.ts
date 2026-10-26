// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Emptying the browser stores of one origin, for the resets each dotli origin offers. A part that could not finish
// rejects, so no caller reports a wipe that left data behind as done.

import { deleteIdb } from './deleteIdb.js';

/** A store an origin wipe empties, by the name its failure is counted under. */
export type OriginWipePart = 'indexeddb' | 'cache_storage' | 'service_worker';

/** The stores of one origin. A store this browser lacks is `null` and has nothing to wipe. */
export type OriginStores = {
  indexedDB: Pick<IDBFactory, 'databases' | 'deleteDatabase'> | null;
  caches: Pick<CacheStorage, 'keys' | 'delete'> | null;
  serviceWorker: Pick<ServiceWorkerContainer, 'getRegistrations'> | null;
};

type Params = {
  keepDatabases?: readonly string[];
  signal?: AbortSignal | undefined;
};

/**
 * Empties each store in turn, except the databases in `keepDatabases`, whatever happened to the one before, then
 * rejects with an `OriginWipeError` naming every part that failed. `signal` stops the wait of each database delete,
 * which fails the database part with the AbortError of `deleteIdb`. With no database to delete the wipe is not affected,
 * and an abort during the database listing takes effect once the listing returns.
 */
export async function wipeOriginStores(
  stores: OriginStores,
  { keepDatabases = [], signal }: Params = {},
): Promise<void> {
  const failures = new Map<OriginWipePart, unknown>();
  const { indexedDB: idb, caches, serviceWorker } = stores;
  if (idb !== null) {
    await run('indexeddb', () => deleteAllDatabases(idb, { keepDatabases, signal }));
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

  async function run(part: OriginWipePart, wipe: () => Promise<unknown>): Promise<void> {
    try {
      await wipe();
    } catch (error) {
      failures.set(part, error);
    }
  }
}

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
 * Deletes every database but those named in `keepDatabases`, and resolves the names it deleted. Rejects when this browser
 * cannot list its databases, as older Firefox and Safari cannot, and when a delete fails or stays blocked. `signal`
 * stops the wait of each database delete, which rejects with the AbortError of `deleteIdb`. With no database to delete
 * it resolves, and an abort during the listing takes effect once the listing returns.
 */
export async function deleteAllDatabases(
  factory: Pick<IDBFactory, 'databases' | 'deleteDatabase'>,
  { keepDatabases = [], signal }: Params = {},
): Promise<readonly string[]> {
  if (typeof factory.databases !== 'function') {
    throw new Error('This browser cannot list its IndexedDB databases');
  }
  const names = (await factory.databases())
    .map(database => database.name)
    .filter((name): name is string => name !== undefined && name !== '' && !keepDatabases.includes(name));
  await Promise.all(names.map(name => deleteIdb(factory, name, { signal })));
  return names;
}
