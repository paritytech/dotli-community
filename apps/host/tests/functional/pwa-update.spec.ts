// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, type Page } from '@playwright/test';

import { createServer } from 'node:http';

import { readFile } from 'node:fs/promises';

import { extname, resolve, sep } from 'node:path';

import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

interface UpgradeFixture {
  origin: string;
  readonly failedWorkerRequests: number;
  setWorkerAvailable(available: boolean): void;
  publishWorker(): void;
  close(): Promise<void>;
}

async function serveUpgrade(): Promise<UpgradeFixture> {
  // Fail before launching the fixture if the production build is missing.
  const [html, worker] = await Promise.all([
    readFile(resolve(DIST, 'index.html')),
    readFile(resolve(DIST, 'host-sw.js'), 'utf8'),
  ]);
  let release = 0;
  let workerAvailable = true;
  let failedWorkerRequests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Service-Worker-Allowed', '/');
      if (pathname === '/host-sw.js') {
        if (!workerAvailable) {
          failedWorkerRequests += 1;
          response.destroy();
          return;
        }
        response.setHeader('Content-Type', 'text/javascript');
        // A byte-only release marker creates a genuine browser SW update
        // without copying, patching, or substituting the generated worker.
        response.end(`${worker}\n// test release ${String(release)}\n`);
        return;
      }
      if (pathname === '/' || pathname === '/index.html') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(html);
        return;
      }
      if (pathname === '/dotli-network.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end('window.__DOTLI_NETWORK__ = {};\n');
        return;
      }
      const path = resolve(DIST, `.${decodeURIComponent(pathname)}`);
      if (!path.startsWith(`${resolve(DIST)}${sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const bytes = await readFile(path);
      response.setHeader('Content-Type', MIME[extname(path)] ?? 'application/octet-stream');
      response.end(bytes);
    })().catch((error: unknown) => {
      response.writeHead(404).end(String(error));
    });
  });
  const listening = Promise.withResolvers<undefined>();
  server.once('error', (error: Error) => {
    listening.reject(error);
  });
  server.listen(0, '127.0.0.1', () => {
    listening.resolve(undefined);
  });
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected an ephemeral TCP listener');
  }
  return {
    origin: `http://pwa-upgrade.localhost:${String(address.port)}`,
    get failedWorkerRequests(): number {
      return failedWorkerRequests;
    },
    setWorkerAvailable(available: boolean): void {
      workerAvailable = available;
    },
    publishWorker(): void {
      release += 1;
    },
    async close(): Promise<void> {
      const closed = Promise.withResolvers<undefined>();
      server.close(error => {
        if (error !== undefined) {
          closed.reject(error);
        } else {
          closed.resolve(undefined);
        }
      });
      server.closeAllConnections();
      await closed.promise;
    },
  };
}

async function seedUserData(page: Page): Promise<void> {
  await page.evaluate(async () => {
    localStorage.setItem('dotli-theme', 'dark');
    localStorage.setItem('upgrade-user-setting', 'keep my settings');
    const opened = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open('upgrade-user-data', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => {
      opened.resolve(request.result);
    };
    request.onerror = () => {
      opened.reject(new Error('Could not open upgrade user data', { cause: request.error }));
    };
    const db = await opened.promise;
    const written = Promise.withResolvers<undefined>();
    const transaction = db.transaction('records', 'readwrite');
    transaction.objectStore('records').put({ message: 'keep my saved record' }, 'saved');
    transaction.oncomplete = () => {
      written.resolve(undefined);
    };
    transaction.onerror = () => {
      written.reject(new Error('Could not save upgrade user data', { cause: transaction.error }));
    };
    transaction.onabort = () => {
      written.reject(new Error('Saving upgrade user data was aborted', { cause: transaction.error }));
    };
    await written.promise;
    db.close();
    const cache = await caches.open('upgrade-product-data');
    await cache.put('/saved-product', new Response('keep my product cache'));
  });
}

async function expectUserData(page: Page): Promise<void> {
  const saved = await page.evaluate(async () => {
    const opened = Promise.withResolvers<IDBDatabase>();
    const openRequest = indexedDB.open('upgrade-user-data', 1);
    openRequest.onsuccess = () => {
      opened.resolve(openRequest.result);
    };
    openRequest.onerror = () => {
      opened.reject(new Error('Could not open saved upgrade data', { cause: openRequest.error }));
    };
    const db = await opened.promise;
    try {
      const savedRecord = Promise.withResolvers<unknown>();
      const request = db.transaction('records').objectStore('records').get('saved');
      request.onsuccess = () => {
        savedRecord.resolve(request.result);
      };
      request.onerror = () => {
        savedRecord.reject(new Error('Could not read saved upgrade data', { cause: request.error }));
      };
      const record = await savedRecord.promise;
      return {
        theme: localStorage.getItem('dotli-theme'),
        setting: localStorage.getItem('upgrade-user-setting'),
        record,
        product: await (await caches.match('/saved-product'))?.text(),
      };
    } finally {
      db.close();
    }
  });
  expect(saved).toEqual({
    theme: 'dark',
    setting: 'keep my settings',
    record: { message: 'keep my saved record' },
    product: 'keep my product cache',
  });
}

test.describe('host service worker update recovery', () => {
  test.setTimeout(60_000);
  for (const trigger of ['interval', 'visibility', 'required'] as const) {
    test(`recovers from a failed ${trigger} update check without losing the active host`, async ({ browser }) => {
      const fixture = await serveUpgrade();
      const context = await browser.newContext({ serviceWorkers: 'allow' });
      try {
        await context.route('**/*', route => {
          return new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort();
        });
        const page = await context.newPage();
        const errors: Error[] = [];
        page.on('pageerror', error => errors.push(error));
        if (trigger === 'interval') {
          // Drive only the real poll callback: advancing every page timer
          // would also expire the deliberately disconnected protocol iframe.
          await page.addInitScript(() => {
            window.setInterval = new Proxy(window.setInterval.bind(window), {
              apply(schedule, receiver: unknown, args: unknown[]): unknown {
                const [handler, delay, ...parameters] = args;
                if (delay === 15 * 60 * 1000 && typeof handler === 'function') {
                  window.addEventListener('test:host-update-poll', () => {
                    Reflect.apply(handler, window, parameters);
                  });
                }
                return Reflect.apply(schedule, receiver, args);
              },
            });
          });
        }
        await page.goto(fixture.origin);
        await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
        await page.reload();
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
        await expect(page.locator('body[data-host]')).toBeVisible();
        await seedUserData(page);
        let navigations = 0;
        page.on('framenavigated', frame => {
          if (frame === page.mainFrame()) {
            navigations += 1;
          }
        });
        const check = async (): Promise<void> => {
          if (trigger === 'interval') {
            await page.evaluate(() => window.dispatchEvent(new Event('test:host-update-poll')));
          } else {
            await page.evaluate(kind => {
              if (kind === 'visibility') {
                document.dispatchEvent(new Event('visibilitychange'));
              } else {
                window.dispatchEvent(new Event('dotli:host-update-required'));
              }
            }, trigger);
          }
        };
        fixture.setWorkerAvailable(false);
        await check();
        await expect.poll(() => fixture.failedWorkerRequests).toBeGreaterThan(0);
        // Drain the browser's real update-job queue while the endpoint is still
        // failing. This catches only the probe's rejection, not the production
        // handler's separate promise, which must never escape as a page error.
        await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          await registration.update().catch(() => undefined);
        });
        await expectUserData(page);
        expect(errors).toEqual([]);
        expect(navigations).toBe(0);
        expect(
          await page.evaluate(async () => {
            const registration = await navigator.serviceWorker.ready;
            return {
              active: registration.active?.state,
              controlled: navigator.serviceWorker.controller === registration.active,
              waiting: registration.waiting !== null,
            };
          }),
        ).toEqual({ active: 'activated', controlled: true, waiting: false });
        fixture.publishWorker();
        fixture.setWorkerAvailable(true);
        await check();
        if (trigger !== 'required') {
          const reload = page.getByTestId('notif-cards').getByRole('button', { name: 'Reload', exact: true });
          await expect(reload).toBeVisible();
          expect(navigations).toBe(0);
          await reload.click();
        }
        await expect.poll(() => navigations).toBe(1);
        await expect(page.locator('body[data-host]')).toBeVisible();
        await expectUserData(page);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
        await fixture.close();
      }
    });
  }
});
