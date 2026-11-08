// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { SITE_ID } from '@dotli/config';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { catchRejection, createManualTimers, readOutcome, type ManualTimers } from '@dotli/shared/testing';
import { ok } from '@dotli/transport';
import type { SharedStoreStatus } from './createSharedStore.js';
import { PROTOCOL_ERRORS, ProtocolFatalError, ProtocolHandshakeTimeoutError } from './errors.js';
import type { ProtocolStatus } from './frameTypes.js';
import { protocolSchema } from './schema.js';
import { SHARED_CORE_SESSION_KEY } from './sharedAuthKeys.js';
import { FRAME_CONFIG, FRAME_ORIGIN } from './testing/constants.js';
import { createFrameHost, type FrameHost } from './testing/createFrameHost.js';
import type { FakeIframe } from './testing/fakeIframe.js';

const { storage } = protocolSchema.sections;

/** The clock and timers each test moves by hand. */
let timers: ManualTimers;

beforeEach(() => {
  timers = createManualTimers();
});

describe('createProtocolClient', () => {
  it('As a dotli integrator, I build a client on my own document and origin, and it mounts its frame there only when asked', async () => {
    // Given
    const host = createFrameHost({ config: FRAME_CONFIG, timers });
    const other = createFrameHost({ config: FRAME_CONFIG, timers });
    await timers.advance(0);
    const framesBeforeAsking = host.countFrames();

    // When
    void host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => undefined);
    await timers.advance(0);

    // Then
    expect(framesBeforeAsking).toBe(0);
    expect(host.countFrames()).toBe(1);
    expect(new URL(host.getIframe().src).origin).toBe(FRAME_ORIGIN);
    expect(other.countFrames()).toBe(0);
  });

  it('As a dotli integrator, I give the client shorter frame timeouts, and a frame that never gets ready fails within them', async () => {
    // Given
    const host = createFrameHost({ timeouts: { readyMs: 1_000 }, config: FRAME_CONFIG, timers });
    const outcome = readOutcome(host.client.resolve.warmup());
    await host.listen();

    // When
    await timers.advance(1_000);

    // Then
    expect(await outcome).toBe(PROTOCOL_ERRORS.FRAME_READY_TIMEOUT);
  });
});

/** The query the frame was built with. */
function readFrameParams(iframe: FakeIframe): Record<string, string> {
  return Object.fromEntries(new URL(iframe.src).searchParams.entries());
}

describe('frame.configure', () => {
  it('As the host, I configure the frame before anything asks for it, and only the first request boots it, with that config', async () => {
    // Given
    const host = createFrameHost({ config: null, timers });

    // When
    host.client.frame.configure({
      backend: 'smoldot-shared-worker',
      network: 'previewnet',
      skipWorkerCache: true,
    });
    await timers.advance(0);
    const framesBeforeAsking = host.countFrames();
    void host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => undefined);
    await timers.advance(0);

    // Then
    expect(framesBeforeAsking).toBe(0);
    expect(readFrameParams(host.getIframe())).toEqual({
      mode: 'shared-worker',
      network: 'previewnet',
      skipWorkerCache: '1',
    });
  });

  it('As a dotli integrator, I request before the frame is configured and nothing mounts while the host has time to configure it', async () => {
    // Given
    const host = createFrameHost({ timeouts: { configureMs: 30_000 }, config: null, timers });
    let settled = false;

    // When
    host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await timers.advance(29_999);

    // Then
    expect(host.countFrames()).toBe(0);
    expect(settled).toBe(false);
    expect(host.client.frame.status.get()).toBe('idle');
  });

  it('As a dotli integrator on a page that never configures the frame, I make a request and it fails after the configure wait and names why', async () => {
    // Given
    const host = createFrameHost({ timeouts: { configureMs: 30_000 }, config: null, timers });

    // When
    const read = catchRejection(host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY));
    await timers.advance(30_000);

    // Then
    await expect(read).resolves.toMatchObject({ message: PROTOCOL_ERRORS.FRAME_UNCONFIGURED });
    expect(host.countFrames()).toBe(0);
    expect(host.client.frame.status.get()).toBe('idle');
  });

  it('As a dotli integrator, I request before the frame is configured and my requests go through once the host configures it, on one frame', async () => {
    // Given
    const host = createFrameHost({ config: null, timers });
    const first = host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY);
    const second = host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY);
    await timers.advance(0);

    // When
    host.client.frame.configure(FRAME_CONFIG);
    await timers.advance(0);
    const served: string[] = [];
    host.serve().handleRequest(storage.authRead, ({ key }) => {
      served.push(key);
      return ok('session');
    });
    await host.listen();

    // Then
    await expect(first).resolves.toBe('session');
    await expect(second).resolves.toBe('session');
    expect(served).toEqual([SHARED_CORE_SESSION_KEY, SHARED_CORE_SESSION_KEY]);
    expect(host.countFrames()).toBe(1);
  });

  it('As the host, I configure the same frame again and nothing is rebuilt', async () => {
    // Given
    const host = createFrameHost({ config: FRAME_CONFIG, timers });
    void host.client.frame.ensureReady();
    const frame = host.getIframe();
    host.getFrameStatus().markReady();
    await host.listen();
    const statuses: ProtocolStatus[] = [];
    host.client.frame.status.listen(status => statuses.push(status));

    // When
    host.client.frame.configure({ ...FRAME_CONFIG });
    await timers.advance(0);

    // Then
    expect(host.getIframe()).toBe(frame);
    expect(statuses).toEqual([]);
    expect(host.client.frame.status.get()).toBe('ready');
  });

  it('As the host, I change the config of a booted frame, and it is rebuilt at once with the new one', async () => {
    // Given
    const host = createFrameHost({ config: FRAME_CONFIG, timers });
    const warmup = catchRejection(host.client.resolve.warmup());
    const old = host.getIframe();
    await host.listen();

    // When
    host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await timers.advance(0);

    // Then
    expect((await warmup).message).toBe(PROTOCOL_ERRORS.FRAME_RESET);
    expect(old.isConnected).toBe(false);
    expect(readFrameParams(host.getIframe())['mode']).toBe('rpc');
    expect(host.client.frame.status.get()).toBe('booting');
  });

  it('As the host, I take a pending reset that asks for a clean chain database, and a frame booted without it is rebuilt with it', async () => {
    // Given: the shared store's first read booted the frame before the reset was known.
    const host = createFrameHost({ config: FRAME_CONFIG, timers });
    void host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => undefined);
    await host.listen();

    // When
    host.client.frame.configure({ ...FRAME_CONFIG, skipWorkerCache: true });
    await timers.advance(0);

    // Then
    expect(readFrameParams(host.getIframe())['skipWorkerCache']).toBe('1');
  });

  it('As the host, I change the config of a frame nobody asked for yet, and nothing boots', async () => {
    // Given
    const host = createFrameHost({ config: FRAME_CONFIG, timers });

    // When
    host.client.frame.configure({ ...FRAME_CONFIG, network: 'previewnet' });
    await timers.advance(0);

    // Then
    expect(host.countFrames()).toBe(0);
    expect(host.client.frame.status.get()).toBe('idle');
  });
});

describe('protocol iframe listening handshake', () => {
  let host: FrameHost;

  beforeEach(() => {
    host = createFrameHost({ config: FRAME_CONFIG, timers });
  });

  it('As a returning user whose protocol iframe script never runs, I read my shared session and it fails within seconds', async () => {
    // Given
    const outcome = catchRejection(host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY));
    const iframe = host.getIframe();

    // When
    await timers.advance(5_000);

    // Then
    expect(await outcome).toBeInstanceOf(ProtocolHandshakeTimeoutError);
    expect(iframe.isConnected).toBe(false);
  });

  it('As a returning user whose protocol iframe never answers its handshake, I see the loss counted by the frame and no feed end reported', async () => {
    // Given a frame whose handshake goes unanswered, with my shared auth followed and its telemetry heard
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    host.client.sharedAuth.subscribe(() => undefined);
    void host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => undefined);

    // When the handshake times out, which ends both feeds before the frame counts its loss, and the first wait passes
    await timers.advance(5_000);
    await timers.advance(1_000);

    // Then
    expect(sentry.counted('protocol.iframe_ready')).toContainEqual(
      expect.objectContaining({ outcome: 'error', reason: 'ProtocolHandshakeTimeoutError' }),
    );
    expect(sentry.counted('protocol.feed_end')).toEqual([]);
  });

  it('As a returning user, I read my shared session and it goes out as soon as the iframe listens, before it is ready', async () => {
    // Given
    const read = host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY);

    // When
    host.serve().handleRequest(storage.authRead, () => ok('0x0102'));
    await host.listen();

    // Then
    await expect(read).resolves.toBe('0x0102');
    expect(host.client.frame.status.get()).toBe('listening');
  });

  it('As a returning user whose protocol iframe died, I find the shared store rebuilt it unasked and available again', async () => {
    // Given
    const statuses: SharedStoreStatus[] = [];
    onTestFinished(host.client.sharedStore.status.listen(status => statuses.push(status)));
    const failed = host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => 'failed');
    const dead = host.getIframe();
    await timers.advance(5_000);

    // When with no request waiting, the store builds a new frame 2 s later, which listens
    await timers.advance(2_000);
    const rebuilt = host.getIframe();
    await host.listen();

    // Then
    expect(await failed).toBe('failed');
    expect(rebuilt).not.toBe(dead);
    expect(statuses.slice(-2)).toEqual(['unavailable', 'available']);
    expect(host.client.sharedStore.status.get()).toBe('available');
  });

  it('As a returning user whose protocol iframe keeps dying, I see a new one tried after a wait that doubles each time', async () => {
    // Given the first frame never answers its handshake, though its document loads
    const failed = host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY).catch(() => 'failed');
    await timers.advance(5_000);

    // When the first rebuild comes 2 s later and fails 5 s after that, then the store waits 4 s
    await timers.advance(1_999);
    const framesBeforeFirstWait = host.countFrames();
    await timers.advance(1);
    const framesAfterFirstWait = host.countFrames();
    await timers.advance(5_000 + 3_999);
    const framesBeforeSecondWait = host.countFrames();
    await timers.advance(1);

    // Then
    expect(await failed).toBe('failed');
    expect(framesBeforeFirstWait).toBe(0);
    expect(framesAfterFirstWait).toBe(1);
    expect(framesBeforeSecondWait).toBe(0);
    expect(host.countFrames()).toBe(1);
  });

  it('As a returning user, I change the frame config mid-read and my shared session read fails at once, not at its timeout', async () => {
    // Given a read the listening frame has not answered yet
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const settled: string[] = [];
    void readOutcome(host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY)).then(outcome =>
      settled.push(outcome),
    );
    host.serve().handleRequest(storage.authRead, () => new Promise(() => undefined));
    await host.listen();

    // When
    host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await timers.advance(0);
    const settledAtReset = [...settled];
    await timers.advance(30_000);

    // Then
    expect(settledAtReset).toEqual([PROTOCOL_ERRORS.FRAME_RESET]);
    expect(settled).toEqual([PROTOCOL_ERRORS.FRAME_RESET]);
    expect(sentry.counted('protocol.request')).toContainEqual(
      expect.objectContaining({ outcome: 'error', method: 'authStorageRead' }),
    );
    expect(sentry.counted('protocol.request')).not.toContainEqual(
      expect.objectContaining({ outcome: 'timeout', method: 'authStorageRead' }),
    );
  });

  it('As a returning user, I write a setting and change the frame config in the same turn, and the write fails at once instead of going to a frame that cannot hear it', async () => {
    // Given a listening frame
    void host.client.sharedMode.read(SITE_ID, 'backend').catch(() => undefined);
    host.serve().handleRequest(storage.modeRead, () => ok(null));
    await host.listen();
    const settled: string[] = [];

    // When
    void readOutcome(host.client.sharedMode.write({ siteId: SITE_ID, key: 'backend', value: 'rpc-gateway' })).then(
      outcome => settled.push(outcome),
    );
    host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await host.listen();

    // Then
    expect(settled).toEqual([PROTOCOL_ERRORS.FRAME_RESET]);
    expect(host.readSent().filter(message => message.tag === 'request')).toEqual([]);
  });

  it('As a returning user whose protocol frame dies, I see the shared store report it down and rebuild it unasked', async () => {
    // Given a frame that listens
    const statuses: SharedStoreStatus[] = [];
    onTestFinished(host.client.sharedStore.status.listen(status => statuses.push(status)));
    onTestFinished(host.client.sharedAuth.subscribe(() => undefined));
    const dead = host.getIframe();
    const status = host.getFrameStatus();
    await host.listen();

    // When it dies, and with no request waiting the store builds a new frame 2 s later, which listens
    status.fail(new ProtocolFatalError('boom'));
    await timers.advance(1_999);
    const statusAfterFatal = host.client.sharedStore.status.get();
    const framesBeforeInterval = host.countFrames();
    await timers.advance(1);
    const rebuilt = host.getIframe();
    await host.listen();

    // Then
    expect(statusAfterFatal).toBe('unavailable');
    expect(framesBeforeInterval).toBe(0);
    expect(dead.isConnected).toBe(false);
    expect(rebuilt).not.toBe(dead);
    expect(statuses.slice(-2)).toEqual(['unavailable', 'available']);
    expect(host.client.sharedStore.status.get()).toBe('available');
  });
});
