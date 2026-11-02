// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { test as base } from '@playwright/test';
import type { APIRequestContext, APIResponse, BrowserContext, Page } from '@playwright/test';
import { PORT } from '../../env.js';

// 127.0.0.1 because Node on Linux CI does not resolve `*.localhost`.
const SHARED_STORE = `http://127.0.0.1:${PORT}/__dotli-mode/`;

/** The signed-in flag's key in the store, which stands in for the root domain's cookie on localhost. */
const SESSION_FLAG = 'has_session';

/** Sends one store request and throws on a non-OK answer, naming the request after `what`. */
async function storeRequest(
  request: APIRequestContext,
  method: 'get' | 'put' | 'delete',
  url: string,
  what: string,
  data?: string,
): Promise<APIResponse> {
  const res = await request[method](url, data === undefined ? undefined : { data });
  if (!res.ok()) {
    throw new Error(`[shared-mode-reset] ${what} returned HTTP ${String(res.status())}`);
  }
  return res;
}

/**
 * Wipes the preview server's process-wide mode-sync store, the signed-in flag included, or a sibling spec's
 * `rpc-gateway` write silently reroutes this test through RPC and its sign-in outlives it.
 */
export async function resetSharedMode(request: APIRequestContext): Promise<void> {
  await storeRequest(request, 'delete', SHARED_STORE, 'preview-server');
}

/** Whether the store holds the signed-in flag. */
export async function readSessionFlag(request: APIRequestContext): Promise<boolean> {
  const res = await storeRequest(request, 'get', `${SHARED_STORE}${SESSION_FLAG}`, 'reading the flag');
  return res.status() !== 204;
}

/**
 * Sets the signed-in flag again, so a page that loads keeps whatever is stored and shows signed out only where nothing
 * is.
 */
export async function setSessionFlag(request: APIRequestContext): Promise<void> {
  await storeRequest(request, 'put', `${SHARED_STORE}${SESSION_FLAG}`, 'setting the flag', '1');
}

/** Deletes the signed-in flag, standing in for a sign-out on another product, so what a page holds is a stale copy. */
export async function clearSessionFlag(request: APIRequestContext): Promise<void> {
  await storeRequest(request, 'delete', `${SHARED_STORE}${SESSION_FLAG}`, 'clearing the flag');
}

/** On in debug builds, the panel's docked filter bar overlaps controls the tests click. */
export async function disableTruapiDebugPanel(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    try {
      sessionStorage.setItem('dotli:truapi-debug', '0');
      // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in exotic init contexts; fixture is best-effort.
    } catch {
      /* ignore */
    }
  });
}

/** Specs that seed `dotli:chain-backend` must import `test` from here. */
export const test = base.extend<{ keepDebugChoice: boolean; _resetSharedMode: undefined }>({
  /** Leaves the debug panel to the page, for a test of how the page turns it on and off. */
  keepDebugChoice: [false, { option: true }],
  _resetSharedMode: [
    async ({ request, page, keepDebugChoice }, use) => {
      await resetSharedMode(request);
      if (!keepDebugChoice) {
        await disableTruapiDebugPanel(page);
      }
      await use(undefined);
    },
    { auto: true },
  ],
});
