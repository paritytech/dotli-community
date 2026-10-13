// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SITE_ID } from '@dotli/config';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { bindLogSink } from '@dotli/shared';
import { SHARED_CORE_SESSION_KEY } from './auth-storage.js';
import type { ProtocolStatus, SharedStoreStatus } from './client.js';
import { PROTOCOL_ERRORS } from './errors.js';
import type { ProtocolRequestEnvelope } from './messages.js';
import { createFrameHost, FRAME_CONFIG, FRAME_ORIGIN, type FakeIframe, type FrameHost } from './testing/frame-host.js';

describe('createProtocolClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a dotli integrator, I build a client on my own document and origin, and it mounts its frame there only when asked', async () => {
    // Given
    vi.useFakeTimers();
    const host = createFrameHost();
    const other = createFrameHost();
    await vi.advanceTimersByTimeAsync(0);
    const framesBeforeAsking = host.frames();

    // When
    void host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(framesBeforeAsking).toBe(0);
    expect(host.frames()).toBe(1);
    expect(new URL(host.iframe().src).origin).toBe(FRAME_ORIGIN);
    expect(other.frames()).toBe(0);
  });

  it('As a dotli integrator, I give the client shorter frame timeouts, and a frame that never listens fails within them', async () => {
    // Given
    vi.useFakeTimers();
    const host = createFrameHost({ listenMs: 50 });
    const outcome = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    await vi.advanceTimersByTimeAsync(0);

    // When
    host.iframe().dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(50);

    // Then
    expect(await outcome).toBe(PROTOCOL_ERRORS.HOST_FRAME_NOT_LISTENING);
  });
});

/** The query the frame was built with. */
function frameParams(iframe: FakeIframe): Record<string, string> {
  return Object.fromEntries(new URL(iframe.src).searchParams.entries());
}

describe('configureProtocolFrame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('As the host, I configure the frame before anything asks for it, and only the first request boots it, with that config', async () => {
    // Given
    const host = createFrameHost(undefined, null);

    // When
    host.client.configureProtocolFrame({ mode: 'shared-worker', network: 'previewnet', skipWorkerCache: true });
    await vi.advanceTimersByTimeAsync(0);
    const framesBeforeAsking = host.frames();
    void host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(framesBeforeAsking).toBe(0);
    expect(frameParams(host.iframe())).toEqual({
      mode: 'shared-worker',
      network: 'previewnet',
      skipWorkerCache: '1',
    });
  });

  it('As a dotli integrator, I request before the frame is configured and nothing mounts while the host has time to configure it', async () => {
    // Given
    const host = createFrameHost({ configureMs: 30_000 }, null);
    let settled = false;

    // When
    host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(29_999);

    // Then
    expect(host.frames()).toBe(0);
    expect(settled).toBe(false);
    expect(host.client.getProtocolStatus()).toBe('idle');
  });

  it('As a dotli integrator on a page that never configures the frame, my request fails after the configure wait and names why', async () => {
    // Given
    const host = createFrameHost({ configureMs: 30_000 }, null);

    // When
    const read = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30_000);

    // Then
    await expect(read).resolves.toMatchObject({ message: PROTOCOL_ERRORS.FRAME_UNCONFIGURED });
    expect(host.frames()).toBe(0);
    expect(host.client.getProtocolStatus()).toBe('idle');
  });

  it('As a dotli integrator, I request before the frame is configured and my requests go through once the host configures it, on one frame', async () => {
    // Given
    const host = createFrameHost(undefined, null);
    const first = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
    const second = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
    await vi.advanceTimersByTimeAsync(0);

    // When
    host.client.configureProtocolFrame(FRAME_CONFIG);
    await vi.advanceTimersByTimeAsync(0);
    const frameWindow = host.iframe().contentWindow;
    if (frameWindow === null) {
      throw new Error('protocol iframe has no window');
    }
    const posted: ProtocolRequestEnvelope[] = [];
    vi.spyOn(frameWindow, 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as ProtocolRequestEnvelope);
    });
    host.deliver({ namespace: 'dotli:protocol', kind: 'listening' });
    await vi.advanceTimersByTimeAsync(0);
    for (const request of posted) {
      host.deliver({ namespace: 'dotli:protocol', kind: 'response', id: request.id, ok: true, result: 'session' });
    }

    // Then
    await expect(first).resolves.toBe('session');
    await expect(second).resolves.toBe('session');
    expect(posted).toHaveLength(2);
    expect(host.frames()).toBe(1);
  });

  it('As the host, I configure the same frame again and nothing is rebuilt', async () => {
    // Given
    const host = createFrameHost();
    void host.client.ensureProtocolFrame();
    await vi.advanceTimersByTimeAsync(0);
    const frame = host.iframe();
    host.deliver({ namespace: 'dotli:protocol', kind: 'ready' });
    const statuses: ProtocolStatus[] = [];
    host.client.subscribeProtocolStatus(status => statuses.push(status));

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG });
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(host.iframe()).toBe(frame);
    expect(statuses).toEqual([]);
    expect(host.client.getProtocolStatus()).toBe('ready');
  });

  it('As the host, I change the config of a booted frame, and it is rebuilt at once with the new one', async () => {
    // Given
    const host = createFrameHost();
    const warmup = host.client.warmupProtocol().catch((err: unknown) => (err as Error).message);
    await vi.advanceTimersByTimeAsync(0);
    const old = host.iframe();
    host.deliver({ namespace: 'dotli:protocol', kind: 'listening' });
    await vi.advanceTimersByTimeAsync(0);

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, mode: 'rpc' });
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(await warmup).toBe(PROTOCOL_ERRORS.FRAME_RESET);
    expect(old.isConnected).toBe(false);
    expect(frameParams(host.iframe())['mode']).toBe('rpc');
    expect(host.client.getProtocolStatus()).toBe('booting');
  });

  it('As a dotli maintainer, I change the config of a booted frame and the trail says it was rebuilt for that, apart from a fatal', async () => {
    // Given
    const host = createFrameHost();
    void host.client.ensureProtocolFrame().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    host.deliver({ namespace: 'dotli:protocol', kind: 'listening' });
    const trail: { message: string; attrs: Record<string, unknown> | undefined }[] = [];
    bindLogSink({
      emit: (level, message, attrs) => {
        if (level === 'info') {
          trail.push({ message, attrs });
        }
      },
    });

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG });
    const eventsForSameConfig = trail.length;
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, mode: 'rpc' });

    // Then
    expect(eventsForSameConfig).toBe(0);
    const reconfigured = trail.find(line => line.message === 'protocol frame reconfigured');
    expect(reconfigured?.attrs).toMatchObject({ flow: 'protocol', mode: 'rpc' });
  });

  it('As the host, I take a pending reset that asks for a clean chain database, and a frame booted without it is rebuilt with it', async () => {
    // Given: the shared store's first read booted the frame before the reset was known.
    const host = createFrameHost();
    void host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    host.deliver({ namespace: 'dotli:protocol', kind: 'listening' });

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, skipWorkerCache: true });
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(frameParams(host.iframe())['skipWorkerCache']).toBe('1');
  });

  it('As the host, I change the config of a frame nobody asked for yet, and nothing boots', async () => {
    // Given
    const host = createFrameHost();

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, network: 'previewnet' });
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(host.frames()).toBe(0);
    expect(host.client.getProtocolStatus()).toBe('idle');
  });
});

describe('protocol iframe listening handshake', () => {
  let host: FrameHost;

  beforeEach(() => {
    host = createFrameHost();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('As a returning user whose protocol iframe script never runs, I read my shared session and it fails within seconds', async () => {
    // Given
    vi.useFakeTimers();
    const outcome = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    await vi.advanceTimersByTimeAsync(0);
    const iframe = host.iframe();

    // When
    iframe.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(5_000);

    // Then
    expect(await outcome).toBe(PROTOCOL_ERRORS.HOST_FRAME_NOT_LISTENING);
    expect(iframe.isConnected).toBe(false);
  });

  it('As a returning user, I read my shared session and it goes out as soon as the iframe listens, before it is ready', async () => {
    // Given
    vi.useFakeTimers();
    const read = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
    await vi.advanceTimersByTimeAsync(0);
    const iframe = host.iframe();
    const frameWindow = iframe.contentWindow;
    if (frameWindow === null) {
      throw new Error('protocol iframe has no window');
    }
    const posted: ProtocolRequestEnvelope[] = [];
    vi.spyOn(frameWindow, 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as ProtocolRequestEnvelope);
    });

    // When
    host.deliver({ namespace: 'dotli:protocol', kind: 'listening' });
    await vi.advanceTimersByTimeAsync(0);
    const request = posted.find(envelope => envelope.method === 'authStorageRead');
    if (request === undefined) {
      throw new Error('no authStorageRead posted');
    }
    host.deliver({ namespace: 'dotli:protocol', kind: 'response', id: request.id, ok: true, result: '0x0102' });

    // Then
    await expect(read).resolves.toBe('0x0102');
  });

  it('As a returning user whose protocol iframe died, I find the shared store rebuilt it unasked and available again', async () => {
    // Given
    vi.useFakeTimers();
    const statuses: SharedStoreStatus[] = [];
    const unsubscribe = host.client.subscribeSharedStoreStatus(status => statuses.push(status));
    const failed = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(0);
    const dead = host.iframe();
    dead.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(5_000);

    // When: with no request waiting, the store builds a new frame 2 s later, which listens.
    await vi.advanceTimersByTimeAsync(2_000);
    const rebuilt = host.iframe();
    host.deliver({ namespace: 'dotli:protocol', kind: 'listening' });
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(await failed).toBe('failed');
    expect(rebuilt).not.toBe(dead);
    expect(statuses.slice(-2)).toEqual(['unavailable', 'available']);
    expect(host.client.getSharedStoreStatus()).toBe('available');
    unsubscribe();
  });

  it('As a returning user whose protocol iframe keeps dying, I see a new one tried after a wait that doubles each time', async () => {
    // Given: the first frame never listens (happy-dom fires `load` itself for every rebuild).
    vi.useFakeTimers();
    const failed = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(0);
    host.iframe().dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(5_000);

    // When: the first rebuild comes 2 s later and fails 5 s after that, then the store waits 4 s.
    await vi.advanceTimersByTimeAsync(1_999);
    const framesBeforeFirstWait = host.frames();
    await vi.advanceTimersByTimeAsync(1);
    const framesAfterFirstWait = host.frames();
    await vi.advanceTimersByTimeAsync(5_000 + 3_999);
    const framesBeforeSecondWait = host.frames();
    await vi.advanceTimersByTimeAsync(1);

    // Then
    expect(await failed).toBe('failed');
    expect(framesBeforeFirstWait).toBe(0);
    expect(framesAfterFirstWait).toBe(1);
    expect(framesBeforeSecondWait).toBe(0);
    expect(host.frames()).toBe(1);
  });

  it('As a returning user, I change the frame config mid-read and my shared session read fails at once, not at its timeout', async () => {
    // Given: a read the listening frame has not answered yet
    vi.useFakeTimers();
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const settled: string[] = [];
    void host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).then(
      () => settled.push('resolved'),
      (err: unknown) => settled.push(err instanceof Error ? err.message : String(err)),
    );
    await vi.advanceTimersByTimeAsync(0);
    const iframe = host.iframe();
    const frameWindow = iframe.contentWindow;
    if (frameWindow === null) {
      throw new Error('protocol iframe has no window');
    }
    vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined);
    host.deliver({ namespace: 'dotli:protocol', kind: 'listening' });
    await vi.advanceTimersByTimeAsync(0);

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, mode: 'rpc' });
    await vi.advanceTimersByTimeAsync(0);
    const settledAtReset = [...settled];
    await vi.advanceTimersByTimeAsync(30_000);

    // Then
    expect(settledAtReset).toEqual([PROTOCOL_ERRORS.FRAME_RESET]);
    expect(settled).toEqual([PROTOCOL_ERRORS.FRAME_RESET]);
    expect(sentry.counted(S.PROTOCOL_REQUEST)).toContainEqual(
      expect.objectContaining({ outcome: 'error', method: 'authStorageRead' }),
    );
    expect(sentry.counted(S.PROTOCOL_REQUEST)).not.toContainEqual(
      expect.objectContaining({ outcome: 'timeout', method: 'authStorageRead' }),
    );
  });

  it('As a returning user whose protocol frame dies, I see the shared store report it down and rebuild it unasked', async () => {
    // Given: a frame that listens
    vi.useFakeTimers();
    const statuses: SharedStoreStatus[] = [];
    const unsubscribeStatus = host.client.subscribeSharedStoreStatus(status => statuses.push(status));
    const unsubscribeAuth = host.client.subscribeSharedAuthStorage(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const dead = host.iframe();
    host.deliver({ namespace: 'dotli:protocol', kind: 'listening' });
    await vi.advanceTimersByTimeAsync(0);

    // When: it dies, and with no request waiting the store builds a new frame 2 s later, which listens.
    host.deliver({ namespace: 'dotli:protocol', kind: 'fatal', message: 'boom' });
    await vi.advanceTimersByTimeAsync(1_999);
    const statusAfterFatal = host.client.getSharedStoreStatus();
    const framesBeforeInterval = host.frames();
    await vi.advanceTimersByTimeAsync(1);
    const rebuilt = host.iframe();
    host.deliver({ namespace: 'dotli:protocol', kind: 'listening' });
    await vi.advanceTimersByTimeAsync(0);

    // Then
    expect(statusAfterFatal).toBe('unavailable');
    expect(framesBeforeInterval).toBe(0);
    expect(dead.isConnected).toBe(false);
    expect(rebuilt).not.toBe(dead);
    expect(statuses.slice(-2)).toEqual(['unavailable', 'available']);
    expect(host.client.getSharedStoreStatus()).toBe('available');
    unsubscribeAuth();
    unsubscribeStatus();
  });
});
