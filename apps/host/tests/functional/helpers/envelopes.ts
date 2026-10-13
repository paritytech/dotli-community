// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Records what the protocol frame tells the host page. Release builds log nothing, so the envelopes are what a test
// reads to see a message cross from the frame to the host.

import type { BrowserContext, Page } from '@playwright/test';
import { PORT } from '../../env.js';

/** An envelope as the host page received it. */
export interface RecordedEnvelope {
  kind: string;
  [field: string]: unknown;
}

/** Call before the first navigation. Records only in a host page's top window, where the host listens. */
export async function recordProtocolEnvelopes(target: BrowserContext | Page): Promise<void> {
  await target.addInitScript((protocolOrigin: string) => {
    if (window.top !== window || location.hostname === 'host.localhost') {
      return;
    }
    const seen: unknown[] = [];
    Object.defineProperty(window, '__dotliEnvelopes', { value: seen });
    window.addEventListener('message', (event: MessageEvent<{ namespace?: unknown } | null>) => {
      if (event.origin === protocolOrigin && event.data?.namespace === 'dotli:protocol') {
        seen.push(event.data);
      }
    });
  }, `http://host.localhost:${PORT}`);
}

/** Waits until the host page has received an envelope of `kind` that `matches`, and returns it. */
export async function waitForEnvelope(
  page: Page,
  kind: string,
  timeout: number,
  matches: Record<string, unknown> = {},
): Promise<RecordedEnvelope> {
  const handle = await page.waitForFunction(
    ({ wanted, fields }) =>
      ((window as unknown as { __dotliEnvelopes?: Record<string, unknown>[] }).__dotliEnvelopes ?? []).find(
        envelope =>
          envelope['kind'] === wanted && Object.entries(fields).every(([key, value]) => envelope[key] === value),
      ),
    { wanted: kind, fields: matches },
    { timeout },
  );
  return (await handle.jsonValue()) as RecordedEnvelope;
}
