// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { SITE_ID } from '@dotli/config';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { manualTimers, type ManualTimers } from '@dotli/shared/testing';
import { ok } from '@dotli/transport';
import { SHARED_CORE_SESSION_KEY } from './auth-storage.js';
import { isProtocolTrait } from './testing/traits.js';
import type { ProtocolStatus, SharedStoreStatus } from './client.js';
import { PROTOCOL_ERRORS, ProtocolFatalError, ProtocolHandshakeTimeoutError } from './errors.js';
import { protocolSchema } from './schema.js';
import { recordWireMessage } from './testing/index.js';
import {
  createFrameHost,
  FRAME_CONFIG,
  FRAME_ORIGIN,
  type FakeIframe,
  type FrameDom,
  type FrameHost,
} from './testing/frame-host.js';

const { storage } = protocolSchema.traits;

// The host posts its handshake again this often until it is answered.
const HANDSHAKE_RETRY_MS = 50;

/** The clock and timers each test moves by hand. */
let timers: ManualTimers;

beforeEach(() => {
  timers = manualTimers();
});

/** Answers the current iframe as the frame app would, so it listens once its handshake is answered. */
async function listen(dom: FrameDom): Promise<void> {
  dom.status();
  await timers.advance(HANDSHAKE_RETRY_MS);
}

/** The requests the host sent `iframe`, as `trait.method`, its handshakes left out. */
function sent(iframe: FakeIframe): string[] {
  return iframe.window.posted.flatMap(data => {
    const message = data instanceof ArrayBuffer ? recordWireMessage(data) : null;
    return message?.tag === 'request' && isProtocolTrait(message.trait) ? [`${message.trait}.${message.method}`] : [];
  });
}

describe('createProtocolClient', () => {
  it('As a dotli integrator, I build a client on my own document and origin, and it mounts its frame there only when asked', async () => {
    // Given
    const host = createFrameHost(undefined, FRAME_CONFIG, timers);
    const other = createFrameHost(undefined, FRAME_CONFIG, timers);
    await timers.advance(0);
    const framesBeforeAsking = host.frames();

    // When
    void host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => undefined);
    await timers.advance(0);

    // Then
    expect(framesBeforeAsking).toBe(0);
    expect(host.frames()).toBe(1);
    expect(new URL(host.iframe().src).origin).toBe(FRAME_ORIGIN);
    expect(other.frames()).toBe(0);
  });

  it('As a dotli integrator, I give the client shorter frame timeouts, and a frame that never gets ready fails within them', async () => {
    // Given
    const host = createFrameHost({ readyMs: 1_000 }, FRAME_CONFIG, timers);
    const outcome = host.client.warmupProtocol().then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    await listen(host);

    // When
    await timers.advance(1_000);

    // Then
    expect(await outcome).toBe(PROTOCOL_ERRORS.FRAME_READY_TIMEOUT);
  });
});

/** The query the frame was built with. */
function frameParams(iframe: FakeIframe): Record<string, string> {
  return Object.fromEntries(new URL(iframe.src).searchParams.entries());
}

describe('configureProtocolFrame', () => {
  it('As the host, I configure the frame before anything asks for it, and only the first request boots it, with that config', async () => {
    // Given
    const host = createFrameHost(undefined, null, timers);

    // When
    host.client.configureProtocolFrame({
      backend: 'smoldot-shared-worker',
      network: 'previewnet',
      skipWorkerCache: true,
    });
    await timers.advance(0);
    const framesBeforeAsking = host.frames();
    void host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => undefined);
    await timers.advance(0);

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
    const host = createFrameHost({ configureMs: 30_000 }, null, timers);
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
    await timers.advance(29_999);

    // Then
    expect(host.frames()).toBe(0);
    expect(settled).toBe(false);
    expect(host.client.getProtocolStatus()).toBe('idle');
  });

  it('As a dotli integrator on a page that never configures the frame, my request fails after the configure wait and names why', async () => {
    // Given
    const host = createFrameHost({ configureMs: 30_000 }, null, timers);

    // When
    const read = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch((err: unknown) => err);
    await timers.advance(30_000);

    // Then
    await expect(read).resolves.toMatchObject({ message: PROTOCOL_ERRORS.FRAME_UNCONFIGURED });
    expect(host.frames()).toBe(0);
    expect(host.client.getProtocolStatus()).toBe('idle');
  });

  it('As a dotli integrator, I request before the frame is configured and my requests go through once the host configures it, on one frame', async () => {
    // Given
    const host = createFrameHost(undefined, null, timers);
    const first = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
    const second = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
    await timers.advance(0);

    // When
    host.client.configureProtocolFrame(FRAME_CONFIG);
    await timers.advance(0);
    const served: string[] = [];
    host.serve().handleRequest(storage.authRead, ({ key }) => {
      served.push(key);
      return ok('session');
    });
    await listen(host);

    // Then
    await expect(first).resolves.toBe('session');
    await expect(second).resolves.toBe('session');
    expect(served).toEqual([SHARED_CORE_SESSION_KEY, SHARED_CORE_SESSION_KEY]);
    expect(host.frames()).toBe(1);
  });

  it('As the host, I configure the same frame again and nothing is rebuilt', async () => {
    // Given
    const host = createFrameHost(undefined, FRAME_CONFIG, timers);
    void host.client.ensureProtocolFrame();
    const frame = host.iframe();
    host.status().ready();
    await listen(host);
    const statuses: ProtocolStatus[] = [];
    host.client.subscribeProtocolStatus(status => statuses.push(status));

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG });
    await timers.advance(0);

    // Then
    expect(host.iframe()).toBe(frame);
    expect(statuses).toEqual([]);
    expect(host.client.getProtocolStatus()).toBe('ready');
  });

  it('As the host, I change the config of a booted frame, and it is rebuilt at once with the new one', async () => {
    // Given
    const host = createFrameHost(undefined, FRAME_CONFIG, timers);
    const warmup = host.client.warmupProtocol().catch((err: unknown) => (err as Error).message);
    const old = host.iframe();
    await listen(host);

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await timers.advance(0);

    // Then
    expect(await warmup).toBe(PROTOCOL_ERRORS.FRAME_RESET);
    expect(old.isConnected).toBe(false);
    expect(frameParams(host.iframe())['mode']).toBe('rpc');
    expect(host.client.getProtocolStatus()).toBe('booting');
  });

  it('As the host, I take a pending reset that asks for a clean chain database, and a frame booted without it is rebuilt with it', async () => {
    // Given: the shared store's first read booted the frame before the reset was known.
    const host = createFrameHost(undefined, FRAME_CONFIG, timers);
    void host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => undefined);
    await listen(host);

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, skipWorkerCache: true });
    await timers.advance(0);

    // Then
    expect(frameParams(host.iframe())['skipWorkerCache']).toBe('1');
  });

  it('As the host, I change the config of a frame nobody asked for yet, and nothing boots', async () => {
    // Given
    const host = createFrameHost(undefined, FRAME_CONFIG, timers);

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, network: 'previewnet' });
    await timers.advance(0);

    // Then
    expect(host.frames()).toBe(0);
    expect(host.client.getProtocolStatus()).toBe('idle');
  });
});

describe('protocol iframe listening handshake', () => {
  let host: FrameHost;

  beforeEach(() => {
    host = createFrameHost(undefined, FRAME_CONFIG, timers);
  });

  it('As a returning user whose protocol iframe script never runs, I read my shared session and it fails within seconds', async () => {
    // Given
    const outcome = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch((err: unknown) => err);
    const iframe = host.iframe();

    // When
    await timers.advance(5_000);

    // Then
    expect(await outcome).toBeInstanceOf(ProtocolHandshakeTimeoutError);
    expect(iframe.isConnected).toBe(false);
  });

  it('As a returning user whose protocol iframe never answers its handshake, the loss is counted by the frame and no feed end is reported', async () => {
    // Given a frame whose handshake goes unanswered, with my shared auth followed and its telemetry heard
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    host.client.subscribeSharedAuthStorage(() => undefined);
    void host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => undefined);

    // When the handshake times out, which ends both feeds before the frame counts its loss, and the first wait passes
    await timers.advance(5_000);
    await timers.advance(1_000);

    // Then
    expect(sentry.counted(S.PROTOCOL_IFRAME_READY)).toContainEqual(
      expect.objectContaining({ outcome: 'error', reason: 'ProtocolHandshakeTimeoutError' }),
    );
    expect(sentry.counted(S.PROTOCOL_FEED_END)).toEqual([]);
  });

  it('As a returning user, I read my shared session and it goes out as soon as the iframe listens, before it is ready', async () => {
    // Given
    const read = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);

    // When
    host.serve().handleRequest(storage.authRead, () => ok('0x0102'));
    await listen(host);

    // Then
    await expect(read).resolves.toBe('0x0102');
    expect(host.client.getProtocolStatus()).toBe('listening');
  });

  it('As a returning user whose protocol iframe died, I find the shared store rebuilt it unasked and available again', async () => {
    // Given
    const statuses: SharedStoreStatus[] = [];
    const unsubscribe = host.client.subscribeSharedStoreStatus(status => statuses.push(status));
    const failed = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => 'failed');
    const dead = host.iframe();
    await timers.advance(5_000);

    // When with no request waiting, the store builds a new frame 2 s later, which listens
    await timers.advance(2_000);
    const rebuilt = host.iframe();
    await listen(host);

    // Then
    expect(await failed).toBe('failed');
    expect(rebuilt).not.toBe(dead);
    expect(statuses.slice(-2)).toEqual(['unavailable', 'available']);
    expect(host.client.getSharedStoreStatus()).toBe('available');
    unsubscribe();
  });

  it('As a returning user whose protocol iframe keeps dying, I see a new one tried after a wait that doubles each time', async () => {
    // Given the first frame never answers its handshake, though its document loads
    const failed = host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => 'failed');
    await timers.advance(5_000);

    // When the first rebuild comes 2 s later and fails 5 s after that, then the store waits 4 s
    await timers.advance(1_999);
    const framesBeforeFirstWait = host.frames();
    await timers.advance(1);
    const framesAfterFirstWait = host.frames();
    await timers.advance(5_000 + 3_999);
    const framesBeforeSecondWait = host.frames();
    await timers.advance(1);

    // Then
    expect(await failed).toBe('failed');
    expect(framesBeforeFirstWait).toBe(0);
    expect(framesAfterFirstWait).toBe(1);
    expect(framesBeforeSecondWait).toBe(0);
    expect(host.frames()).toBe(1);
  });

  it('As a returning user, I change the frame config mid-read and my shared session read fails at once, not at its timeout', async () => {
    // Given a read the listening frame has not answered yet
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const settled: string[] = [];
    void host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY).then(
      () => settled.push('resolved'),
      (err: unknown) => settled.push(err instanceof Error ? err.message : String(err)),
    );
    host.serve().handleRequest(storage.authRead, () => new Promise(() => undefined));
    await listen(host);

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await timers.advance(0);
    const settledAtReset = [...settled];
    await timers.advance(30_000);

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

  it('As a returning user, I write a setting and change the frame config in the same turn, and the write fails at once instead of going to a frame that cannot hear it', async () => {
    // Given a listening frame
    void host.client.readSharedModeStorage(SITE_ID, 'backend').catch(() => undefined);
    host.serve().handleRequest(storage.modeRead, () => ok(null));
    await listen(host);
    const settled: string[] = [];

    // When
    void host.client.writeSharedModeStorage(SITE_ID, 'backend', 'rpc-gateway').then(
      () => settled.push('resolved'),
      (err: unknown) => settled.push(err instanceof Error ? err.message : String(err)),
    );
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await listen(host);

    // Then
    expect(settled).toEqual([PROTOCOL_ERRORS.FRAME_RESET]);
    expect(sent(host.iframe())).toEqual([]);
  });

  it('As a returning user whose protocol frame dies, I see the shared store report it down and rebuild it unasked', async () => {
    // Given a frame that listens
    const statuses: SharedStoreStatus[] = [];
    const unsubscribeStatus = host.client.subscribeSharedStoreStatus(status => statuses.push(status));
    const unsubscribeAuth = host.client.subscribeSharedAuthStorage(() => undefined);
    const dead = host.iframe();
    const status = host.status();
    await listen(host);

    // When it dies, and with no request waiting the store builds a new frame 2 s later, which listens
    status.fail(new ProtocolFatalError('boom'));
    await timers.advance(1_999);
    const statusAfterFatal = host.client.getSharedStoreStatus();
    const framesBeforeInterval = host.frames();
    await timers.advance(1);
    const rebuilt = host.iframe();
    await listen(host);

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
