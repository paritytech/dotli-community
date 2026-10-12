// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
// The protocol iframe's host does not exist here, so happy-dom must not fetch it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SITE_ID } from '@dotli/config';
import { SHARED_CORE_SESSION_KEY } from '../src/auth-storage.js';
import {
  getProtocolOrigin,
  getSharedStoreStatus,
  readSharedAuthStorage,
  resetProtocolFrame,
  subscribeSharedStoreStatus,
  type SharedStoreStatus,
} from '../src/client.js';
import { PROTOCOL_ERRORS } from '../src/errors.js';
import type { ProtocolEnvelope, ProtocolRequestEnvelope } from '../src/messages.js';

function protocolIframe(): HTMLIFrameElement {
  const iframe = document.querySelector('iframe');
  if (iframe === null) {
    throw new Error('missing protocol iframe');
  }
  return iframe;
}

function deliver(iframe: HTMLIFrameElement, envelope: ProtocolEnvelope): void {
  window.dispatchEvent(
    new MessageEvent('message', { data: envelope, origin: getProtocolOrigin(), source: iframe.contentWindow }),
  );
}

describe('protocol iframe listening handshake', () => {
  afterEach(() => {
    resetProtocolFrame();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('As a returning user whose protocol iframe script never runs, my shared session read fails within seconds', async () => {
    // Given
    vi.useFakeTimers();
    const outcome = readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    await vi.advanceTimersByTimeAsync(0);
    const iframe = protocolIframe();

    // When
    iframe.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(5_000);

    // Then
    expect(await outcome).toBe(PROTOCOL_ERRORS.HOST_FRAME_NOT_LISTENING);
    expect(iframe.isConnected).toBe(false);
  });

  it('As a returning user, my shared session read goes out as soon as the iframe listens, before it is ready', async () => {
    // Given
    vi.useFakeTimers();
    const read = readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
    await vi.advanceTimersByTimeAsync(0);
    const iframe = protocolIframe();
    const frameWindow = iframe.contentWindow;
    if (frameWindow === null) {
      throw new Error('protocol iframe has no window');
    }
    const posted: ProtocolRequestEnvelope[] = [];
    vi.spyOn(frameWindow, 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as ProtocolRequestEnvelope);
    });

    // When
    deliver(iframe, { namespace: 'dotli:protocol', kind: 'listening' });
    await vi.advanceTimersByTimeAsync(0);
    const request = posted.find(envelope => envelope.method === 'authStorageRead');
    if (request === undefined) {
      throw new Error('no authStorageRead posted');
    }
    deliver(iframe, { namespace: 'dotli:protocol', kind: 'response', id: request.id, ok: true, result: '0x0102' });

    // Then
    await expect(read).resolves.toBe('0x0102');
  });

  it('As a returning user whose protocol iframe died, the shared store rebuilds it unasked and is available again', async () => {
    // Given
    vi.useFakeTimers();
    const statuses: SharedStoreStatus[] = [];
    const unsubscribe = subscribeSharedStoreStatus(status => statuses.push(status));
    const failed = readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(0);
    const dead = protocolIframe();
    dead.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(5_000);

    // When: with no request waiting, the store builds a new frame, which listens.
    const rebuilt = protocolIframe();
    deliver(rebuilt, { namespace: 'dotli:protocol', kind: 'listening' });
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(await failed).toBe('failed');
    expect(rebuilt).not.toBe(dead);
    expect(statuses.slice(-2)).toEqual(['unavailable', 'available']);
    expect(getSharedStoreStatus()).toBe('available');
    unsubscribe();
  });

  it('As a returning user whose protocol iframe keeps dying, a new one is tried 2 s after each failed attempt', async () => {
    // Given: the first frame dies, and the store's own rebuild dies too (happy-dom fires `load` itself).
    vi.useFakeTimers();
    const failed = readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(0);
    protocolIframe().dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(10_000);

    // When
    await vi.advanceTimersByTimeAsync(1_000);
    const framesBeforeInterval = document.querySelectorAll('iframe').length;
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(await failed).toBe('failed');
    expect(framesBeforeInterval).toBe(0);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });
});
