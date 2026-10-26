// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the fake protocol frame in place of the protocol iframe. The frame's document loads the built fake with its
// options as JSON on the script tag, so the fake runs only in that frame and is listening before the host speaks.

import { expect, type Frame, type Page } from '@playwright/test';
import type { BlockMode, FakeProtocolOptions } from '../wire/fake-protocol-frame.js';
import { isProtocolFrameUrl } from './frames.js';
import { FAKE_PROTOCOL_BUNDLE_PATH } from './wire-bundles.js';

// Under the frame's own path, so the root origin's pages never load it.
const FAKE_SCRIPT_PATH = '/__protocol/__dotli-e2e/fake-protocol-frame.js';

/** HTML attribute text for `value`, which may hold any character. */
const attribute = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

/** Serves the fake protocol frame for every protocol frame the page builds, the frame's rebuilds included. */
export async function fakeProtocol(page: Page, options: FakeProtocolOptions): Promise<void> {
  const document = `<!DOCTYPE html><html><head><meta charset="utf-8"><script src="${FAKE_SCRIPT_PATH}" data-options="${attribute(JSON.stringify(options))}"></script></head><body></body></html>`;
  await page.route('**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!isProtocolFrameUrl(url.href)) {
      await route.fallback();
    } else if (url.pathname === FAKE_SCRIPT_PATH) {
      await route.fulfill({ path: FAKE_PROTOCOL_BUNDLE_PATH, contentType: 'text/javascript' });
    } else if (request.resourceType() === 'document') {
      await route.fulfill({ contentType: 'text/html', body: document });
    } else {
      await route.fallback();
    }
  });
}

/** A frame whose boot cannot start. */
export const initFailed = (message: string): FakeProtocolOptions => ({ initFailed: message });

/** A frame whose light client crashes once a name is asked for. */
export const fatalOnResolve = (message: string): FakeProtocolOptions => ({ resolve: { kind: 'fatal', message } });

export const errorResolveResponse = (message: string, delayMs = 0, name?: string): FakeProtocolOptions => ({
  resolve: name === undefined ? { kind: 'error', message, delayMs } : { kind: 'error', message, delayMs, name },
});

export const nullResolveResponse: FakeProtocolOptions = { resolve: { kind: 'none' } };

export const successfulResolveResponse = (cid: string): FakeProtocolOptions => ({ resolve: { kind: 'cid', cid } });

/** The protocol frame the page has now, waited for. */
async function protocolFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some(frame => isProtocolFrameUrl(frame.url()))).toBe(true);
  const frame = page.frames().find(candidate => isProtocolFrameUrl(candidate.url()));
  if (frame === undefined) {
    throw new Error('the protocol frame went away');
  }
  return frame;
}

/** `bitswap_v1_get` asks the fake has had for `cid`. */
export async function blockGets(page: Page, cid: string): Promise<number> {
  const frame = await protocolFrame(page);
  return frame.evaluate(target => window.__fakeProtocol?.gets[target] ?? 0, cid);
}

export async function setBlockMode(page: Page, cid: string, mode: BlockMode): Promise<void> {
  const frame = await protocolFrame(page);
  await frame.evaluate(
    ([target, next]) => {
      window.__fakeProtocol?.setMode(target, next);
    },
    [cid, mode] as const,
  );
}

export async function releaseBlock(page: Page, cid: string): Promise<void> {
  const frame = await protocolFrame(page);
  await frame.evaluate(target => {
    window.__fakeProtocol?.release(target);
  }, cid);
}
