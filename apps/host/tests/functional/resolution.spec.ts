// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import { DOMAIN, DOTNS_NAME, PORT, TIMEOUT_MS } from '../env.js';
import { setupTest } from './helpers/context.js';
import { waitForResolutionOutcome } from '../product-frame.js';
import { BACKENDS, seedSettings } from './fixtures/settings.js';
import { BROWSER_PERMISSIONS, seedPermissions } from './fixtures/permissions.js';
import { test } from './helpers/shared-mode-reset.js';

const BASE_URL = `http://${DOMAIN}.localhost:${PORT}/`;

/** A second product, so session 2 cannot be answered from the content cache. */
const WARM_DOMAIN = process.env['WARM_DOMAIN'] ?? 'browse';
const WARM_BASE_URL = `http://${WARM_DOMAIN}.localhost:${PORT}/`;
/** The provider's smoldot database store lives on this origin. */
const PROTOCOL_ORIGIN = `http://host.localhost:${PORT}`;
/** Long enough for the provider to write its first warm-start blob to IndexedDB. */
const SNAPSHOT_WINDOW_MS = 35_000;

test.setTimeout(BACKENDS.length * TIMEOUT_MS * 2);

test.describe('Resolution across chain backends', () => {
  for (const backend of BACKENDS) {
    test(`As a user opening ${DOTNS_NAME} via ${backend}, the shell loads the app`, async ({ browser }) => {
      // Given
      const { context, page } = await setupTest(browser, { backend });

      try {
        // When
        await page.goto(BASE_URL, { waitUntil: 'commit' });

        // Then
        await waitForResolutionOutcome(page, TIMEOUT_MS, backend);
      } finally {
        await context.close();
      }
    });
  }

  test(`As a user opening ${DOMAIN}.dot, I am shown how many peers the light client found`, async ({ browser }) => {
    // Given
    const { context, page } = await setupTest(browser, {
      backend: 'smoldot-direct',
    });

    try {
      // The rendered figure can change faster than a poll catches, so the envelope is the reliable signal.
      await page.addInitScript(() => {
        const seen: unknown[] = [];
        (window as unknown as { __dotliPeerCounts: unknown[] }).__dotliPeerCounts = seen;
        window.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as {
            namespace?: string;
            kind?: string;
            syncKind?: string;
            peers?: number;
          } | null;
          if (
            data !== null &&
            typeof data === 'object' &&
            data.namespace === 'dotli:protocol' &&
            data.kind === 'chain-sync' &&
            data.syncKind === 'peers' &&
            typeof data.peers === 'number'
          ) {
            seen.push(data);
          }
        });
      });

      // When
      await page.goto(BASE_URL, { waitUntil: 'commit' });

      // Then
      const sawPeers = page.waitForFunction(
        () => {
          const seen = (window as unknown as { __dotliPeerCounts?: unknown[] }).__dotliPeerCounts;
          return seen !== undefined && seen.length > 0;
        },
        undefined,
        { timeout: TIMEOUT_MS },
      );
      await Promise.all([sawPeers, waitForResolutionOutcome(page, TIMEOUT_MS, 'smoldot-direct')]);
    } finally {
      await context.close();
    }
  });
});

interface SmoldotDbState {
  /** Genesis hash of every chain with a stored database blob. */
  stored: string[];
  /** Genesis hash of every chain the provider resumed from storage. */
  loaded: string[];
}

/** The protocol iframe is the test's only view of warm start, since the default backend writes from a SharedWorker. */
async function readSmoldotDb(page: Page): Promise<SmoldotDbState> {
  const frame = page.frames().find(f => f.url().startsWith(PROTOCOL_ORIGIN));
  if (frame === undefined) {
    throw new Error(`no protocol frame at ${PROTOCOL_ORIGIN}`);
  }
  return frame.evaluate(async () => {
    const keys = (db: IDBDatabase, store: string): Promise<string[]> =>
      new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains(store)) {
          resolve([]);
          return;
        }
        const req = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
        req.onsuccess = () => {
          resolve(req.result.map(String));
        };
        req.onerror = () => {
          reject(req.error ?? new Error(`read ${store} failed`));
        };
      });

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('dotli-smoldot-db');
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(req.error ?? new Error('open smoldot-db failed'));
      };
    });
    try {
      return {
        stored: await keys(db, 'chain-databases'),
        loaded: await keys(db, 'loads'),
      };
    } finally {
      db.close();
    }
  });
}

/** A context locks its profile directory, so each session must close before the next one opens. */
async function withWarmSession<T>(
  profile: string,
  url: string,
  label: string,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await chromium.launchPersistentContext(profile, {
    permissions: [...BROWSER_PERMISSIONS],
  });
  try {
    await seedPermissions(context);
    await seedSettings(context, { backend: 'smoldot-shared-worker' });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'commit' });
    await waitForResolutionOutcome(page, TIMEOUT_MS, label);
    return await run(page);
  } finally {
    await context.close();
  }
}

test.describe('Warm start across a browser restart', () => {
  // No `test.setTimeout`: every wait inside is bounded, so a hang surfaces with the failing session named.

  test(`As a user returning after quitting the browser, ${WARM_DOMAIN} resumes the light client from stored state`, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'dotli-warm-'));
    try {
      // Given
      const primed = await withWarmSession(profile, BASE_URL, 'warm start, session 1', async page => {
        await page.waitForTimeout(SNAPSHOT_WINDOW_MS);
        return readSmoldotDb(page);
      });
      expect(primed.stored, 'session 1 stored no database blobs').not.toEqual([]);
      expect(primed.loaded, 'session 1 had nothing to resume from').toEqual([]);

      // When
      const resumed = await withWarmSession(profile, WARM_BASE_URL, 'warm start, session 2', readSmoldotDb);

      // Then
      expect(resumed.loaded, 'session 2 resumed no chain from storage').not.toEqual([]);
      expect(primed.stored).toEqual(expect.arrayContaining(resumed.loaded));
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
