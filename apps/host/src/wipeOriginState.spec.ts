// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { wipeOriginState, type WipeParts } from './wipeOriginState.js';
import { SMOLDOT_DB_NAME } from '@dotli/chains';
import { SITE_GRANTS_DB_NAME, WALLET_DB_NAME } from '@dotli/storage';
import { createMemoryStorage } from '@dotli/shared/testing';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createSafeStorage, type OriginStores } from '@dotli/shared';

/** An origin's storages, and the parts a wipe empties over them. */
type Origin = {
  local: Storage;
  session: Storage;
  /** Returns a browser with none of the stores a wipe empties, over this origin's storages, unless `stores` adds them. */
  createWipeParts: (stores?: Partial<OriginStores>) => WipeParts;
};

type Params = {
  /** The databases the origin holds. */
  names: string[];
};

describe('full reset', () => {
  it('As a dotli user, I reset my settings and the colour scheme I chose stays', async () => {
    // Given
    const { local, session, createWipeParts } = setupOrigin();
    local.setItem('dotli-theme', 'light');
    local.setItem('dotli:network', 'paseo');

    // When
    await wipeOriginState(createWipeParts());

    // Then the theme survives the wipe, so callers no longer snapshot it themselves
    expect(local.getItem('dotli-theme')).toBe('light');
    expect(local.getItem('dotli:network')).toBeNull();
    expect(session.length).toBe(0);
  });

  it("As a user on the landing page, I wipe its origin and the frame's session, settings and wallet stay", async () => {
    // Given the frame's keys and databases beside the page's own
    const { local, createWipeParts } = setupOrigin();
    local.setItem('TRUAPI_dot.li_session', 'signed-in');
    local.setItem('DOTLI_MODE_dot.li_x', 'smoldot');
    local.setItem('dotli:network', 'paseo');
    const { indexedDB, deleted } = createRecordingDatabases({ names: ['dotli', WALLET_DB_NAME, SMOLDOT_DB_NAME] });

    // When the origin is wiped
    await wipeOriginState(createWipeParts({ indexedDB }));

    // Then only the page's own data went
    expect(local.getItem('TRUAPI_dot.li_session')).toBe('signed-in');
    expect(local.getItem('DOTLI_MODE_dot.li_x')).toBe('smoldot');
    expect(local.getItem('dotli:network')).toBeNull();
    expect(deleted).toEqual(['dotli']);
  });

  it("As a user on the landing page, I wipe its origin and the session windows' site grants stay", async () => {
    // Given the grants database beside the page's own
    const { createWipeParts } = setupOrigin();
    const { indexedDB, deleted } = createRecordingDatabases({ names: ['dotli', SITE_GRANTS_DB_NAME] });

    // When the origin is wiped
    await wipeOriginState(createWipeParts({ indexedDB }));

    // Then only the page's own database went
    expect(deleted).toEqual(['dotli']);
  });

  it("As a user on the landing page, I wipe its origin and the wipe never writes the frame's keys", async () => {
    // Given the frame's keys and a page key in a storage that records its writes
    const { local, createWipeParts } = setupOrigin();
    local.setItem('TRUAPI_dot.li_session', 'signed-in');
    local.setItem('DOTLI_MODE_dot.li_x', 'smoldot');
    local.setItem('dotli:network', 'paseo');
    const base = createSafeStorage(() => local);
    const calls: string[] = [];
    const recording: WipeParts['local'] = {
      ...base,
      setItem(key, value) {
        calls.push(`setItem ${key}`);
        base.setItem(key, value);
      },
      removeItem(key) {
        calls.push(`removeItem ${key}`);
        base.removeItem(key);
      },
      clear() {
        calls.push('clear');
        base.clear();
      },
    };

    // When the origin is wiped
    await wipeOriginState({ ...createWipeParts(), local: recording });

    // Then nothing cleared the storage or touched a frame key, and only the page's key went
    expect(calls).not.toContain('clear');
    expect(calls.filter(call => /^(setItem|removeItem) (TRUAPI_|DOTLI_MODE_)/.test(call))).toEqual([]);
    expect(local.getItem('TRUAPI_dot.li_session')).toBe('signed-in');
    expect(local.getItem('DOTLI_MODE_dot.li_x')).toBe('smoldot');
    expect(local.getItem('dotli:network')).toBeNull();
  });

  it('As a dotli user who never picked a theme, I reset my settings and no theme is invented', async () => {
    // Given
    const { local, createWipeParts } = setupOrigin();
    local.setItem('dotli:network', 'paseo');

    // When
    await wipeOriginState(createWipeParts());

    // Then
    expect(local.getItem('dotli-theme')).toBeNull();
    expect(local.getItem('dotli:network')).toBeNull();
  });

  it('As an operator, I see the browser refuse to delete a database and it is reported as an expected failure, counted and named to the caller while the other parts still run', async () => {
    // Given a database whose delete fails, and a reporting pipeline that records
    const { local, createWipeParts } = setupOrigin();
    const ran: string[] = [];
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    local.setItem('dotli:network', 'paseo');

    // When
    const failed = await wipeOriginState(
      createWipeParts({
        indexedDB: createRefusingDatabases({ names: ['dotli'] }),
        caches: {
          keys: () => Promise.resolve(['shell']),
          delete() {
            ran.push('cache storage');
            return Promise.resolve(true);
          },
        },
        serviceWorker: {
          getRegistrations: () =>
            Promise.resolve([
              createRegistration(() => {
                ran.push('service workers');
              }),
            ]),
        },
      }),
    );

    // Then the failed part is named, reported and counted, and the rest of the wipe ran
    expect(failed).toEqual(['indexeddb']);
    expect(ran).toEqual(['cache storage', 'service workers']);
    expect(local.getItem('dotli:network')).toBeNull();
    expect(captures.expected).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to delete dotli DB: UnknownError' }),
      { flow: 'storage', step: 'origin_wipe_indexeddb' },
    );
    expect(captures.exception).not.toHaveBeenCalled();
    expect(metrics.counted('settings.origin_wipe')).toEqual([{ outcome: 'error', reason: 'indexeddb' }]);
  });
});

/** Builds an origin whose session holds a continuation and whose local storage is empty. */
function setupOrigin(): Origin {
  const local = createMemoryStorage();
  const session = createMemoryStorage({ entries: { 'dotli:continuation': 'settings_change' } });
  return {
    local,
    session,
    createWipeParts: (stores = {}) => ({
      stores: { indexedDB: null, caches: null, serviceWorker: null, ...stores },
      local: createSafeStorage(() => local),
      session: createSafeStorage(() => session),
    }),
  };
}

/** Returns a database list whose every delete the browser refuses, as `deleteDatabase` fires `error`. */
function createRefusingDatabases({ names }: Params): OriginStores['indexedDB'] {
  return {
    databases: () => Promise.resolve(names.map(name => ({ name, version: 1 }))),
    deleteDatabase() {
      const request = toOpenRequest({ error: new DOMException('refused', 'UnknownError') });
      queueMicrotask(() => {
        request.onerror?.call(request, new Event('error'));
      });
      return request;
    },
  };
}

/** Returns a database list whose every delete succeeds, and the names deleted from it, in order. */
function createRecordingDatabases({ names }: Params): {
  indexedDB: OriginStores['indexedDB'];
  deleted: readonly string[];
} {
  const deleted: string[] = [];
  const indexedDB: OriginStores['indexedDB'] = {
    databases: () => Promise.resolve(names.map(name => ({ name, version: 1 }))),
    deleteDatabase(name) {
      deleted.push(name);
      const request = toOpenRequest({ error: null });
      queueMicrotask(() => {
        request.onsuccess?.call(request, new Event('success'));
      });
      return request;
    },
  };
  return { indexedDB, deleted };
}

function toOpenRequest(fields: Pick<IDBOpenDBRequest, 'error'>): IDBOpenDBRequest {
  // The wipe sets only the request's handlers and reads only its error.
  return fields as IDBOpenDBRequest;
}

/** Returns a worker registration whose unregister calls `onUnregister` and succeeds. */
function createRegistration(onUnregister: () => void): ServiceWorkerRegistration {
  const registration = {
    unregister() {
      onUnregister();
      return Promise.resolve(true);
    },
  };
  // The wipe calls only the registration's unregister.
  return registration as ServiceWorkerRegistration;
}
