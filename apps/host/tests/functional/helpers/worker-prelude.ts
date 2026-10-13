// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Runs test code inside a worker before the worker's own script. Every prelude for one script is collected under one
// route, so a helper's prelude and the log forwarders compose instead of the later route hiding the earlier.

import type { BrowserContext, Page } from '@playwright/test';

const preludes = new WeakMap<BrowserContext, Map<string, string[]>>();

/** Prepends `prelude` to every worker script matching `pattern`, after the preludes already added for it. */
export async function prependToWorker(context: BrowserContext, pattern: string, prelude: string): Promise<void> {
  let byPattern = preludes.get(context);
  if (byPattern === undefined) {
    byPattern = new Map();
    preludes.set(context, byPattern);
  }
  const added = byPattern.get(pattern);
  if (added !== undefined) {
    added.push(prelude);
    return;
  }
  const chain = [prelude];
  byPattern.set(pattern, chain);
  await context.route(pattern, async route => {
    // A fetch the closing page cut short has no script to patch, so the request goes on as it was.
    const response = await route.fetch().catch(() => null);
    if (response === null) {
      await route.continue();
      return;
    }
    await route.fulfill({
      response,
      body: chain.join('\n') + (await response.text()),
      headers: { ...response.headers(), 'content-type': 'application/javascript' },
    });
  });
}

/** The protocol SharedWorker, which the protocol frame starts in SharedWorker mode. */
export const PROTOCOL_SHARED_WORKER = '**/protocol-shared-worker-*.js';

/** The wallet core's worker script. The host loads it as `worker-runtime.<hash>.js`, which builds this one. */
export const CORE_WORKER = '**/assets/worker-runtime-*.js';

/** Fails the light client's engine start in the SharedWorker, whose own fetches no route can see. */
export const BLOCK_PROVIDER_WASM = `(function () {
  var nativeFetch = self.fetch;
  self.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    if (url.indexOf('truapi_provider_bg') !== -1) {
      return Promise.reject(new TypeError('e2e: the provider wasm is blocked'));
    }
    return nativeFetch.call(self, input, init);
  };
})();
`;

const CORE_DEATH_CHANNEL = 'dotli-e2e-core';

/**
 * Lets a test take the wallet core down. The only place a test depends on `@parity/truapi-host`'s worker protocol: a
 * `fatalError` after the runtime is ready is how the vendor reports a core that died, so a vendor upgrade that renames
 * it breaks here.
 */
export const CORE_DEATH = `(function () {
  var channel = new BroadcastChannel(${JSON.stringify(CORE_DEATH_CHANNEL)});
  channel.onmessage = function () {
    self.postMessage({ kind: 'fatalError', error: 'e2e: the core died' });
  };
})();
`;

/** Takes down the core worker running now. The page shares the worker's origin, so the channel reaches it. */
export async function killCore(page: Page): Promise<void> {
  await page.evaluate(name => {
    const channel = new BroadcastChannel(name);
    channel.postMessage('die');
    channel.close();
  }, CORE_DEATH_CHANNEL);
}
