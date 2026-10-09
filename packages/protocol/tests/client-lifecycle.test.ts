// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SITE_ID } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import {
  ensureProtocolFrame,
  getProtocolOrigin,
  isProtocolBooting,
  isProtocolReady,
  requestSharedWallet,
  resetProtocolFrame,
} from '../src/client.js';
import { PROTOCOL_ERRORS } from '../src/errors.js';
import type { ProtocolEnvelope, ProtocolRequestEnvelope } from '../src/messages.js';
import type { SharedWalletOperation, SharedWalletResult } from '../src/wallet-storage.js';

// Match the remote-chain fixture: retain contentWindow without fetching a host.
// Vitest's DOM Window type does not expose happy-dom's test-only settings.
const testWindow = window as unknown as {
  happyDOM: { settings: { navigation: { disableChildFrameNavigation: boolean } } };
};
testWindow.happyDOM.settings.navigation.disableChildFrameNavigation = true;

const wallet: SharedWalletResult = {
  state: { version: 1, revision: null, enabled: false, hasWallet: false, storedInOtherApp: false },
};

interface Frame {
  iframe: HTMLIFrameElement;
  posted: ProtocolRequestEnvelope[];
  deliver: (envelope: ProtocolEnvelope) => void;
}

function captureFrame(): Frame {
  const iframe = document.querySelector('iframe');
  const source = iframe?.contentWindow;
  if (iframe === null || source === null || source === undefined) {
    throw new Error('missing protocol iframe');
  }
  const posted: ProtocolRequestEnvelope[] = [];
  vi.spyOn(source, 'postMessage').mockImplementation((message: unknown) => {
    posted.push(message as ProtocolRequestEnvelope);
  });
  return {
    iframe,
    posted,
    deliver: envelope => {
      window.dispatchEvent(new MessageEvent('message', { data: envelope, origin: getProtocolOrigin(), source }));
    },
  };
}

function respond(frame: Frame, result = wallet): void {
  const request = frame.posted[0];
  if (request === undefined) {
    throw new Error('no wallet request posted');
  }
  frame.deliver({ namespace: 'dotli:protocol', kind: 'response', id: request.id, ok: true, result });
}

describe('protocol wallet frame lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetProtocolFrame();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each<SharedWalletOperation>([{ action: 'state' }, { action: 'create', expectedVersion: 0 }])(
    'As a wallet user, a lost $action response rejects at reset without replay or a delayed timeout',
    async operation => {
      const counts = vi.spyOn(m, 'count');
      const rejected = vi.fn<(error: unknown) => void>();
      const request = requestSharedWallet(SITE_ID, operation).catch(rejected);
      const frame = captureFrame();
      frame.iframe.dispatchEvent(new Event('load'));
      await vi.advanceTimersByTimeAsync(0);
      expect(frame.posted.map(envelope => envelope.payload)).toEqual([{ siteId: SITE_ID, operation }]);

      resetProtocolFrame();
      await request;

      expect(rejected).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ name: 'ProtocolFrameResetError', method: 'walletStorage' }),
      );
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(counts).not.toHaveBeenCalledWith(S.PROTOCOL_REQUEST, { outcome: 'timeout', method: 'walletStorage' });
      expect(rejected).toHaveBeenCalledTimes(1);
      expect(document.querySelector('iframe')).toBeNull();
      expect(frame.posted).toHaveLength(1);
    },
  );

  it('As a wallet user, messages from a retired frame cannot ready, fail or answer its replacement', async () => {
    const first = requestSharedWallet(SITE_ID, { action: 'state' }).catch(() => undefined);
    const old = captureFrame();
    old.iframe.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(0);
    resetProtocolFrame();
    old.deliver({ namespace: 'dotli:protocol', kind: 'ready' });
    expect(isProtocolReady()).toBe(false);

    const resolved = vi.fn<(result: SharedWalletResult) => void>();
    const replacement = requestSharedWallet(SITE_ID, { action: 'state' }).then(resolved);
    const current = captureFrame();
    current.iframe.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(0);
    const request = current.posted[0];
    if (request === undefined) {
      throw new Error('no replacement wallet request');
    }
    old.deliver({ namespace: 'dotli:protocol', kind: 'response', id: request.id, ok: true, result: wallet });
    old.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'retired frame' });
    old.deliver({ namespace: 'dotli:protocol', kind: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).not.toHaveBeenCalled();
    expect(isProtocolReady()).toBe(false);
    expect(current.iframe.isConnected).toBe(true);

    respond(current);
    await replacement;
    await first;
    expect(resolved).toHaveBeenCalledExactlyOnceWith(wallet);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As a wallet user, resetting a loading frame settles its caller and cannot remove the next frame', async () => {
    const rejected = vi.fn<(error: unknown) => void>();
    const first = requestSharedWallet(SITE_ID, { action: 'state' }).catch(rejected);
    const old = captureFrame();
    resetProtocolFrame();
    // Start the replacement before the old load rejection resumes its catch.
    const replacement = requestSharedWallet(SITE_ID, { action: 'state' });
    const current = captureFrame();
    old.iframe.dispatchEvent(new Event('load'));
    old.iframe.dispatchEvent(new Event('error'));
    current.iframe.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: PROTOCOL_ERRORS.FRAME_RESET }));
    expect(old.posted).toEqual([]);
    expect(current.iframe.isConnected).toBe(true);
    expect(current.posted).toHaveLength(1);
    respond(current);
    await expect(replacement).resolves.toEqual(wallet);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As a wallet user, reset between load and post never moves my mutation onto another frame', async () => {
    const rejected = vi.fn<(error: unknown) => void>();
    const mutation = requestSharedWallet(SITE_ID, { action: 'create', expectedVersion: 0 }).catch(rejected);
    const old = captureFrame();
    old.iframe.dispatchEvent(new Event('load'));
    resetProtocolFrame();
    const replacement = requestSharedWallet(SITE_ID, { action: 'state' });
    const current = captureFrame();
    current.iframe.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(0);
    await mutation;
    expect(rejected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'ProtocolFrameResetError', method: 'walletStorage' }),
    );
    expect(old.posted).toEqual([]);
    expect(current.posted.map(envelope => envelope.payload)).toEqual([
      { siteId: SITE_ID, operation: { action: 'state' } },
    ]);
    respond(current);
    await replacement;
  });

  it('As a wallet user, a failed iframe load preserves its cause and the next explicit call starts cleanly', async () => {
    const rejected = vi.fn<(error: unknown) => void>();
    const first = requestSharedWallet(SITE_ID, { action: 'state' }).catch(rejected);
    const old = captureFrame();
    old.iframe.dispatchEvent(new Event('error'));
    await first;
    expect(rejected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: PROTOCOL_ERRORS.HOST_FRAME_LOAD_FAILED }),
    );
    expect(document.querySelector('iframe')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const replacement = requestSharedWallet(SITE_ID, { action: 'state' });
    const current = captureFrame();
    old.iframe.dispatchEvent(new Event('load'));
    current.iframe.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(0);
    respond(current);
    await expect(replacement).resolves.toEqual(wallet);
  });

  it.each([false, true])('As a wallet user, init failure settles the caller even with loaded=%s', async loaded => {
    const rejected = vi.fn<(error: unknown) => void>();
    const request = requestSharedWallet(SITE_ID, { action: 'state' }).catch(rejected);
    const frame = captureFrame();
    if (loaded) {
      frame.iframe.dispatchEvent(new Event('load'));
      await vi.advanceTimersByTimeAsync(0);
    }
    frame.deliver({ namespace: 'dotli:protocol', kind: 'init-failed', message: 'worker unavailable' });
    await request;
    expect(rejected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'ProtocolInitFailedError', message: 'Init failed: worker unavailable' }),
    );
    expect(document.querySelector('iframe')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it('As a wallet user, an old ready rejection cannot poison a replacement waiting to become ready', async () => {
    const first = ensureProtocolFrame().catch(() => undefined);
    const old = captureFrame();
    old.iframe.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(0);
    resetProtocolFrame();
    const ready = ensureProtocolFrame();
    const current = captureFrame();
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(isProtocolBooting()).toBe(true);
    expect(isProtocolReady()).toBe(false);
    current.iframe.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(0);
    current.deliver({ namespace: 'dotli:protocol', kind: 'ready' });
    await ready;
    expect(isProtocolReady()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(240_001);
    expect(current.iframe.isConnected).toBe(true);
  });
});
