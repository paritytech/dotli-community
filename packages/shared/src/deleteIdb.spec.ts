// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { deleteIdb } from './deleteIdb.js';
import { openIdb } from './openIdb.js';
import { createManualTimers } from './testing/createManualTimers.js';

const STORE = 'items';

/** A factory whose database `name` another connection holds open, so a delete of it stays blocked. */
async function heldFactory(name: string): Promise<IDBFactory> {
  const factory = new IDBFactory();
  await openIdb({
    factory,
    name,
    version: 1,
    upgrade: created => {
      created.createObjectStore(STORE);
    },
  });
  return factory;
}

describe('deleteIdb', () => {
  it('As a purge, I delete a database and it is gone once the delete resolves', async () => {
    // Given
    const factory = new IDBFactory();
    const opened = await openIdb({
      factory,
      name: 'gone',
      version: 1,
      upgrade: created => {
        created.createObjectStore(STORE);
      },
    });
    opened.close();

    // When
    await deleteIdb(factory, 'gone');

    // Then
    expect((await factory.databases()).map(info => info.name)).not.toContain('gone');
  });

  it('As a page deleting a database another tab holds open, I wait and the delete completes once that tab closes it', async () => {
    // Given another tab holding the database open
    const factory = new IDBFactory();
    const otherTab = await openIdb({
      factory,
      name: 'held',
      version: 1,
      upgrade: created => {
        created.createObjectStore(STORE);
      },
    });

    // When the delete reports blocked and the other tab then closes its connection
    const deleted = deleteIdb(
      {
        deleteDatabase(name) {
          const request = factory.deleteDatabase(name);
          request.addEventListener('blocked', () => {
            otherTab.close();
          });
          return request;
        },
      },
      'held',
    );

    // Then the delete completes
    await deleted;
    expect((await factory.databases()).map(info => info.name)).not.toContain('held');
  });

  it('As a purge, I delete a database another connection never releases and the delete rejects rather than hangs', async () => {
    // Given
    const factory = await heldFactory('held');

    // When
    const deleted = deleteIdb(factory, 'held', { timeoutMs: 20 });

    // Then
    await expect(deleted).rejects.toThrow('Failed to delete held DB: still blocked by another connection');
  });

  it("As a caller whose delete stays blocked, I get deleteIdb's timeout after DELETE_TIMEOUT_MS", async () => {
    // Given
    const factory = await heldFactory('held');
    const timers = createManualTimers();
    const heard: string[] = [];
    void deleteIdb(factory, 'held', { timers }).then(
      () => heard.push('deleted'),
      (error: unknown) => heard.push(error instanceof Error ? error.message : 'other'),
    );

    // When
    await timers.advance(2_999);
    const beforeTimeout = [...heard];
    await timers.advance(1);

    // Then
    expect(beforeTimeout).toEqual([]);
    expect(heard).toEqual(['Failed to delete held DB: still blocked by another connection after 3000ms']);
  });
});
