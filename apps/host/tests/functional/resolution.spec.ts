// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import { DOMAIN, DOTNS_NAME, PORT, TIMEOUT_MS } from '../env.js';
import { setupTest } from './helpers/context.js';
import { isProtocolFrameUrl } from './helpers/frames.js';
import { recordProtocolMessages, waitForProtocolMessage } from './helpers/wire-recorder.js';
import { waitForResolutionOutcome } from '../product-frame.js';
import { BACKENDS, seedSettings } from './fixtures/settings.js';
import { BROWSER_PERMISSIONS, seedPermissions } from './fixtures/permissions.js';
import { test } from './helpers/shared-mode-reset.js';

const BASE_URL = `http://${DOMAIN}.localhost:${PORT}/`;

/** A second product, so session 2 cannot be answered from the content cache. */
const WARM_DOMAIN = process.env['WARM_DOMAIN'] ?? 'browse';
const WARM_BASE_URL = `http://${WARM_DOMAIN}.localhost:${PORT}/`;
/** The longest the provider takes to write its first warm-start blob to IndexedDB. */
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

  test(`As a user opening ${DOMAIN}.dot, the host hears the light client's peer count`, async ({ browser }) => {
    // Given
    const { context, page } = await setupTest(browser, {
      backend: 'smoldot-direct',
    });

    try {
      // The rendered figure can change faster than a poll catches, so the recorded message is the reliable signal.
      await recordProtocolMessages(page);

      // When
      await page.goto(BASE_URL, { waitUntil: 'commit' });

      // Then
      const sawPeers = waitForProtocolMessage(
        page,
        { section: 'frame', method: 'telemetry', tag: 'receive', body: { tag: 'chainSync', value: { kind: 'peers' } } },
        TIMEOUT_MS,
      );
      const [peers] = await Promise.all([sawPeers, waitForResolutionOutcome(page, TIMEOUT_MS, 'smoldot-direct')]);
      expect(peers.body).toMatchObject({ value: { peers: expect.any(Number) } });
    } finally {
      await context.close();
    }
  });
});

type SmoldotDbState = {
  /** Genesis hash of every chain with a stored database blob. */
  stored: string[];
  /** Genesis hash of every chain the provider resumed from storage. */
  loaded: string[];
};

/** The protocol iframe is the test's only view of warm start, since the default backend writes from a SharedWorker. */
async function readSmoldotDb(page: Page): Promise<SmoldotDbState> {
  // The provider's smoldot database store lives on the frame's origin.
  const frame = page.frames().find(f => isProtocolFrameUrl(f.url()));
  if (frame === undefined) {
    throw new Error('no protocol frame');
  }
  return frame.evaluate(async () => {
    // Opening a database that does not exist yet would create it and block the provider's own upgrade.
    if (!(await indexedDB.databases()).some(d => d.name === 'dotli-smoldot-db')) {
      return { stored: [], loaded: [] };
    }
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
    db.onversionchange = () => {
      db.close();
    };
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
        await expect
          .poll(async () => (await readSmoldotDb(page)).stored, { timeout: SNAPSHOT_WINDOW_MS })
          .not.toEqual([]);
        return readSmoldotDb(page);
      });
      expect(primed.stored, 'session 1 stored no database blobs').not.toEqual([]);
      expect(primed.loaded, 'session 1 had nothing to resume from').toEqual([]);

      // When
      const resumed = await withWarmSession(profile, WARM_BASE_URL, 'warm start, session 2', readSmoldotDb);

      // Then
      expect(resumed.loaded, 'session 2 resumed no chain from storage').not.toEqual([]);
      expect(
        resumed.loaded.some(key => primed.stored.includes(key)),
        'session 2 resumed nothing session 1 stored',
      ).toBe(true);
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
