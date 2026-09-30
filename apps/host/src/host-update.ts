// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

declare const __HOST_SANDBOX_SCHEMA_VERSION__: number;

export {};

const VERSION_REPLY_TIMEOUT_MS = 1_500;

function hasCurrentContract(client: WindowClient): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const channel = new MessageChannel();
  const finish = (matches: boolean): void => {
    clearTimeout(timer);
    channel.port1.onmessage = null;
    channel.port1.close();
    resolve(matches);
  };
  const timer = setTimeout(() => {
    finish(false);
  }, VERSION_REPLY_TIMEOUT_MS);
  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data as { version?: unknown } | null;
    finish(data?.version === __HOST_SANDBOX_SCHEMA_VERSION__);
  };
  try {
    client.postMessage({ type: "dotli:host-contract-version" }, [
      channel.port2,
    ]);
  } catch {
    // The document can disappear while the worker is checking open tabs.
    channel.port2.close();
    finish(false);
  }
  return promise;
}

async function outdatedClients(): Promise<WindowClient[]> {
  const windows = (
    await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  ).filter((client) => client.url.startsWith(self.registration.scope));
  const compatible = await Promise.all(windows.map(hasCurrentContract));
  return windows.filter((_, index) => !compatible[index]);
}

self.addEventListener("install", (event: ExtendableEvent) => {
  if (self.registration.active === null) {
    return;
  }
  event.waitUntil(
    outdatedClients().then(async (clients) => {
      // Compatible sessions retain the normal update prompt. Legacy hosts do
      // not answer this query and cannot be relied on to handle a new sandbox's
      // update request. Activate only after Workbox's precache install succeeds.
      if (clients.length > 0) {
        await self.skipWaiting();
      }
    }),
  );
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      // Probe again: the worker can restart between installation and activation,
      // and a tab may have navigated while the new assets were downloading.
      const clients = await outdatedClients();
      if (clients.length === 0) {
        return;
      }
      await self.clients.claim();
      await Promise.all(
        clients.map(async (client) => {
          const current = await self.clients.get(client.id);
          if (current?.type === "window") {
            // Navigation fetches wait for activation. Awaiting them here would
            // deadlock the worker and every tab it just claimed.
            void (current as WindowClient)
              .navigate(current.url)
              .catch((error: unknown) => {
                console.warn(
                  "[dot.li] Could not reload an outdated host",
                  error,
                );
              });
          }
        }),
      );
    })(),
  );
});
