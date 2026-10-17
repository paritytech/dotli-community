// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { getActiveServicesConfig, SITE_ID } from '@dotli/config';
import { bindCaptureSink, spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { deferred, manualTimers, type ManualTimers } from '@dotli/shared/testing';
import type { RemoteChainHalt } from '@dotli/chains';
import { SHARED_CORE_SESSION_KEY } from './auth-storage.js';
import { createProtocolClient, type ProtocolStatus, type SharedStoreStatus } from './client.js';
import {
  PROTOCOL_ERRORS,
  ProtocolFatalError,
  ProtocolHandshakeTimeoutError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolVersionMismatchError,
} from './errors.js';
import { backendOfFrameMode, createProtocolFrame } from './frame.js';
import { decodeWireMessage, encodeWireMessage } from './wire-message.js';
import {
  createFrameDom,
  createFrameHost,
  FRAME_CONFIG,
  type FakeIframe,
  type FrameDom,
  type FrameHost,
  type FrameStatusServer,
} from './testing/frame-host.js';

// The consumer transport posts its handshake again this often until it is answered.
const HANDSHAKE_RETRY_MS = 50;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const READY_TIMEOUT_MS = 240_000;

/** The clock and timers each test moves by hand. */
let timers: ManualTimers;

beforeEach(() => {
  timers = manualTimers();
});

const advance = (ms = 0): Promise<void> => timers.advance(ms);

/** Answers the current iframe as the frame app would, so it listens once its handshake is answered. */
async function listen(dom: FrameDom): Promise<FrameStatusServer> {
  const status = dom.status();
  await advance(HANDSHAKE_RETRY_MS);
  return status;
}

/** Answers the current iframe and reports its light client ready. */
async function bringUp(dom: FrameDom): Promise<FrameStatusServer> {
  const status = await listen(dom);
  status.ready();
  await advance();
  return status;
}

/** What the host sent `iframe`, as `leg:method`, its handshakes left out. */
function sent(iframe: FakeIframe): string[] {
  return iframe.window.posted.flatMap(data => {
    const decoded = decodeWireMessage(data as ArrayBuffer);
    return decoded.ok && decoded.message.method !== 'handshake'
      ? [`${decoded.message.leg}:${decoded.message.method}`]
      : [];
  });
}

/** How a wait settled, read once it has, with its handler bound at once so a rejection is never unhandled. */
function outcomeOf(wait: Promise<unknown>): Promise<string> {
  return wait.then(
    () => 'resolved',
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

describe('createProtocolFrame', () => {
  it('As a dotli integrator, I hear only what the current frame sends from its origin', async () => {
    // Given a listening frame, and another iframe on the page
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenUp('listening');
    const status = await listen(dom);
    const stranger = dom.stranger();

    // When the other iframe, and the frame from another origin, say the light client is ready
    for (let id = 1; id <= 8; id++) {
      const ready = (): ArrayBuffer => encodeWireMessage({ leg: 'event', id, method: 'frameStatus', event: undefined });
      dom.deliverRaw(ready(), stranger);
      dom.deliverRaw(ready(), dom.iframe(), 'https://evil.example');
    }
    await advance();
    const afterStrangers = frame.getStatus();
    status.ready();
    await advance();

    // Then
    expect(afterStrangers).toBe('listening');
    expect(frame.getStatus()).toBe('ready');
  });

  it('As the host, I start my handshake on the frame load', async () => {
    // Given a frame whose document has not loaded yet
    const dom = createFrameDom(undefined, { mount: null, timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    const up = frame.whenUp('listening');
    dom.status();
    await advance(1_000);
    const postedBeforeLoad = dom.iframe().window.posted.length;

    // When
    dom.iframe().dispatchEvent(new Event('load'));
    await advance();

    // Then
    expect(postedBeforeLoad).toBe(0);
    await expect(up).resolves.toBe(await frame.transport());
    expect(frame.getStatus()).toBe('listening');
  });

  it('As a dotli integrator, I wait for a listening frame without waiting for its light client', async () => {
    // Given
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    const settled: string[] = [];
    void frame.whenUp('listening').then(() => settled.push('listening'));
    void frame.whenUp('ready').then(() => settled.push('ready'));

    // When
    const status = await listen(dom);
    const afterListening = [...settled];
    status.ready();
    await advance();

    // Then
    expect(afterListening).toEqual(['listening']);
    expect(settled).toEqual(['listening', 'ready']);
  });

  it('As a dotli integrator, I ask for the transport and get the current frame one, booting a frame if there is none', async () => {
    // Given
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    const framesBeforeAsking = dom.frames();

    // When
    const first = await frame.transport();
    const second = await frame.transport();
    await bringUp(dom);

    // Then
    expect(framesBeforeAsking).toBe(0);
    expect(dom.frames()).toBe(1);
    expect(second).toBe(first);
    await expect(frame.whenUp('ready')).resolves.toBe(first);
  });

  it('As a dotli integrator, I hear why a frame was dropped once its status says it is down', async () => {
    // Given
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenUp('ready').catch(() => undefined);
    const status = await bringUp(dom);
    const lost: { name: string; message: string; status: ProtocolStatus }[] = [];
    frame.onLost(error => lost.push({ name: error.name, message: error.message, status: frame.getStatus() }));

    // When
    status.fail(new ProtocolFatalError('boom'));
    await advance();

    // Then
    expect(lost).toEqual([{ name: 'ProtocolFatalError', message: 'boom', status: 'failed' }]);
  });

  it('As a dotli integrator, I wait on a frame before it is configured, and it boots and answers once configured', async () => {
    // Given
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    const up = frame.whenUp('listening');
    await advance();
    const framesBeforeConfig = dom.frames();

    // When
    frame.configure(FRAME_CONFIG);
    await advance();
    await listen(dom);

    // Then
    expect(framesBeforeConfig).toBe(0);
    await expect(up).resolves.toBe(await frame.transport());
    expect(dom.frames()).toBe(1);
  });

  it('As the host, a frame that already failed fails my boot when I subscribe its status, and is rebuilt after the first wait', async () => {
    // Given a frame app whose light client failed before the host subscribed its status
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    const up = frame.whenUp('ready').catch((err: unknown) => err);
    dom.status().fail(new ProtocolInitFailedError('no SharedWorker'));

    // When
    await advance(HANDSHAKE_RETRY_MS);
    const failure = await up;
    const statusAfterFailure = frame.getStatus();
    await advance(2_000);

    // Then
    expect(failure).toBeInstanceOf(ProtocolInitFailedError);
    expect((failure as Error).message).toBe('no SharedWorker');
    expect(statusAfterFailure).toBe('failed');
    expect(metrics.counted(S.PROTOCOL_IFRAME_READY)).toEqual([
      { outcome: 'error', phase: 'ready', reason: 'ProtocolInitFailedError' },
    ]);
    expect(dom.frames()).toBe(1);
    expect(frame.getStatus()).toBe('booting');
  });

  it('As the host, one frame loss is counted once', async () => {
    // Given a frame that listens, waiting for its light client, with a request out on its transport
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenUp('ready').catch(() => undefined);
    const status = await listen(dom);
    dom.serve().handleRequest('resolveOwner', () => new Promise<null>(() => undefined));
    const transport = await frame.transport();
    const owner = transport.request('resolveOwner', { label: 'doom' }).catch((err: unknown) => err);
    await advance();

    // When its light client dies, which ends its status, and the loss disposes its transport
    status.fail(new ProtocolFatalError('boom'));
    await advance();

    // Then
    expect(await owner).toBeInstanceOf(ProtocolFatalError);
    expect(frame.losses()).toBe(1);
    expect(metrics.counted(S.PROTOCOL_IFRAME_READY)).toEqual([
      { outcome: 'error', phase: 'ready', reason: 'ProtocolFatalError' },
    ]);
  });

  it('As the host, a ready frame I lose is counted once as lost and captured', async () => {
    // Given a ready frame, and a reporting pipeline that records captures and counts
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenUp('ready').catch(() => undefined);
    const status = await bringUp(dom);

    // When its light client dies
    status.fail(new ProtocolFatalError('boom'));
    await advance();

    // Then
    expect(metrics.counted(S.PROTOCOL_FRAME_LOST)).toEqual([{ outcome: 'error', reason: 'ProtocolFatalError' }]);
    expect(metrics.counted(S.PROTOCOL_IFRAME_READY).filter(tags => tags?.['outcome'] === 'error')).toEqual([]);
    expect(captured).toEqual([{ flow: 'protocol', step: 'frame_lost' }]);
  });

  it('As the host, a ready frame whose port the worker released is counted as lost and not captured', async () => {
    // Given a ready frame, and a reporting pipeline that records captures and counts
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenUp('ready').catch(() => undefined);
    const status = await bringUp(dom);

    // When the tab thaws and finds the SharedWorker let go of its port
    status.fail(new ProtocolPortReleasedError('released'));
    await advance();

    // Then
    expect(metrics.counted(S.PROTOCOL_FRAME_LOST)).toEqual([{ outcome: 'error', reason: 'ProtocolPortReleasedError' }]);
    expect(captured).toEqual([]);
  });

  it('As the host, a late message from a dropped frame settles nothing on the new one', async () => {
    // Given a read the first frame holds while it is dropped
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenUp('ready').catch(() => undefined);
    const first = dom.iframe();
    const held = deferred<string | null>();
    dom.serve(first).handleRequest('authStorageRead', () => held.promise);
    const firstStatus = await bringUp(dom);
    const oldRead = (await frame.transport()).request('authStorageRead', { siteId: SITE_ID, key: 'k' });
    void oldRead.catch(() => undefined);
    await advance();
    firstStatus.fail(new ProtocolFatalError('boom'));
    await advance();

    // And a read on the rebuilt frame, which it never answers
    const rebuilt = await frame.transport();
    dom.serve().handleRequest('authStorageRead', () => new Promise<null>(() => undefined));
    await bringUp(dom);
    const answered: (string | null)[] = [];
    void rebuilt.request('authStorageRead', { siteId: SITE_ID, key: 'k' }).then(answer => answered.push(answer));
    await advance();

    // When the dropped frame answers late, and answers for every id arrive from its window
    held.resolve('stale');
    for (let id = 1; id <= 16; id++) {
      dom.deliverRaw(
        encodeWireMessage({ leg: 'response', id, method: 'authStorageRead', outcome: { ok: true, answer: 'stale' } }),
        first,
      );
    }
    await advance();

    // Then
    expect(answered).toEqual([]);
    await expect(oldRead).rejects.toThrow('boom');
    expect(frame.getStatus()).toBe('ready');
  });

  it('As the host, a version mismatch is final', async () => {
    // Given a frame of another release, which refuses the host wire version
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    const up = frame.whenUp('ready').catch((err: unknown) => err);
    await advance();

    // When
    dom.deliverRaw(
      encodeWireMessage({
        leg: 'response',
        id: 1,
        method: 'handshake',
        outcome: {
          ok: false,
          error: {
            message: 'The peer speaks wire version 1 and this end 2',
            name: 'ProtocolVersionMismatchError',
            stack: null,
          },
        },
      }),
    );
    await advance();
    const failure = await up;
    await advance(60_000);
    const framesAfterBackoff = dom.frames();
    frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await advance(60_000);

    // Then
    expect(failure).toBeInstanceOf(ProtocolVersionMismatchError);
    expect(frame.getStatus()).toBe('failed');
    expect(framesAfterBackoff).toBe(0);
    expect(dom.frames()).toBe(0);
    await expect(frame.whenUp('listening')).rejects.toBeInstanceOf(ProtocolVersionMismatchError);
    await expect(frame.transport()).rejects.toBeInstanceOf(ProtocolVersionMismatchError);
    expect(dom.frames()).toBe(0);
    expect(metrics.counted(S.PROTOCOL_IFRAME_READY)).toEqual([
      { outcome: 'error', phase: 'listen', reason: 'ProtocolVersionMismatchError' },
    ]);
  });

  it('As the host with an app open, a frame rebuilt from a newer release refuses my wire and I hear it once, also when I ask late', async () => {
    // Given a ready frame, and a listener for a mismatch
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenUp('ready').catch(() => undefined);
    const status = await bringUp(dom);
    const heard: Error[] = [];
    frame.onVersionMismatch(error => heard.push(error));

    // When the frame is lost, and the frame rebuilt after the backoff refuses the host wire version
    status.fail(new ProtocolFatalError('boom'));
    await advance(2_000);
    dom.deliverRaw(
      encodeWireMessage({
        leg: 'response',
        id: 1,
        method: 'handshake',
        outcome: {
          ok: false,
          error: {
            message: 'The peer speaks wire version 3 and this end 2',
            name: 'ProtocolVersionMismatchError',
            stack: null,
          },
        },
      }),
    );
    await advance(60_000);
    const late: Error[] = [];
    frame.onVersionMismatch(error => late.push(error));

    // Then the mismatch is final and each listener heard it once
    expect(frame.getStatus()).toBe('failed');
    expect(dom.frames()).toBe(0);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeInstanceOf(ProtocolVersionMismatchError);
    expect(late).toEqual(heard);
  });

  it('As the host, a frame that never answers my handshake fails my boot and rebuilds with backoff', async () => {
    // Given a frame of an earlier release, which loads and never answers
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    const up = frame.whenUp('listening').catch((err: unknown) => err);
    const silent = dom.iframe();

    // When
    await advance(HANDSHAKE_TIMEOUT_MS);
    const failure = await up;
    await advance(1_999);
    const framesBeforeBackoff = dom.frames();
    await advance(1);

    // Then
    expect(failure).toBeInstanceOf(ProtocolHandshakeTimeoutError);
    expect(silent.isConnected).toBe(false);
    expect(metrics.counted(S.PROTOCOL_IFRAME_READY)).toEqual([
      { outcome: 'error', phase: 'listen', reason: 'ProtocolHandshakeTimeoutError' },
    ]);
    expect(framesBeforeBackoff).toBe(0);
    expect(dom.frames()).toBe(1);
  });

  it('As a dotli integrator, I lose a frame that fails the moment it is mounted and it leaves no load timer behind', async () => {
    // Given a page where the frame fails as it is mounted
    const dom = createFrameDom(undefined, { mount: 'error', timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);

    // When
    const up = outcomeOf(frame.whenUp('listening'));
    await advance();

    // Then the wait fails, and only the rebuild's wait is pending
    expect(await up).toContain(PROTOCOL_ERRORS.HOST_FRAME_LOAD_FAILED);
    expect(frame.getStatus()).toBe('failed');
    expect(timers.pending()).toBe(1);
  });

  /** A configured frame that came up ready and then died with a fatal, so its keeper waits to rebuild it. */
  async function frameDownAfterFatal(): Promise<{
    dom: FrameDom;
    frame: ReturnType<typeof createProtocolFrame>;
  }> {
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    const up = frame.whenUp('ready');
    const status = await bringUp(dom);
    await up;
    status.fail(new ProtocolFatalError('boom'));
    await advance();
    return { dom, frame };
  }

  it('As a product, I ask for the chain while the frame waits to rebuild after a fatal, and a new frame boots at once and answers', async () => {
    // Given
    const { dom, frame } = await frameDownAfterFatal();
    const framesWhileDown = dom.frames();

    // When
    const up = outcomeOf(frame.whenUp('ready'));
    const framesAfterAsking = dom.frames();
    await bringUp(dom);

    // Then
    expect(framesWhileDown).toBe(0);
    expect(framesAfterAsking).toBe(1);
    expect(await up).toBe('resolved');
    expect(frame.getStatus()).toBe('ready');
  });

  it('As a product, I ask while the frame is down and the boot I started fails, and I hear that boot failure', async () => {
    // Given
    const { dom, frame } = await frameDownAfterFatal();

    // When
    const up = outcomeOf(frame.whenUp('ready'));
    const status = await listen(dom);
    status.fail(new ProtocolInitFailedError('no SharedWorker'));

    // Then
    expect(await up).toBe('no SharedWorker');
  });

  it('As a host with no caller waiting, I lose the frame and it rebuilds on its own after the backoff', async () => {
    // Given
    const { dom } = await frameDownAfterFatal();

    // When
    await advance(1_999);
    const framesBeforeBackoff = dom.frames();
    await advance(1);

    // Then
    expect(framesBeforeBackoff).toBe(0);
    expect(dom.frames()).toBe(1);
  });

  it('As two products asking while the frame is down, we hear the failure of the one boot we share, and one rebuild follows after the backoff', async () => {
    // Given
    const dom = createFrameDom(undefined, { timers });
    let builds = 0;
    const frame = createProtocolFrame({
      ...dom.deps,
      document: {
        createElement: tagName => {
          builds += 1;
          return dom.deps.document.createElement(tagName);
        },
        body: dom.deps.document.body,
      },
    });
    frame.configure(FRAME_CONFIG);
    const up = frame.whenUp('ready');
    const firstStatus = await bringUp(dom);
    await up;
    firstStatus.fail(new ProtocolFatalError('boom'));
    await advance();
    const buildsBeforeAsking = builds;

    // When
    const first = outcomeOf(frame.whenUp('ready'));
    const second = outcomeOf(frame.whenUp('listening'));
    const framesAfterAsking = dom.frames();
    const status = await listen(dom);
    const secondSettled = await second;
    status.fail(new ProtocolInitFailedError('no SharedWorker'));
    const outcomes = [await first, secondSettled];
    const buildsForUs = builds - buildsBeforeAsking;
    await advance(1_999);
    const framesBeforeBackoff = dom.frames();
    await advance(1);

    // Then
    expect(outcomes).toEqual(['no SharedWorker', 'resolved']);
    expect(framesAfterAsking).toBe(1);
    expect(buildsForUs).toBe(1);
    expect(framesBeforeBackoff).toBe(0);
    expect(dom.frames()).toBe(1);
    expect(builds - buildsBeforeAsking).toBe(2);
  });

  it('As two products asking while the frame is down, we share one rebuild', async () => {
    // Given
    const { dom, frame } = await frameDownAfterFatal();

    // When
    const first = outcomeOf(frame.whenUp('ready'));
    const second = outcomeOf(frame.whenUp('listening'));
    const rebuilt = dom.iframe();
    const framesAfterAsking = dom.frames();
    await bringUp(dom);
    await advance(2_000);

    // Then
    expect(framesAfterAsking).toBe(1);
    expect(await first).toBe('resolved');
    expect(await second).toBe('resolved');
    expect(dom.frames()).toBe(1);
    expect(dom.iframe()).toBe(rebuilt);
  });
});

describe('protocol status', () => {
  let host: FrameHost;

  beforeEach(() => {
    host = createFrameHost(undefined, FRAME_CONFIG, timers);
  });

  function settledWith(promise: Promise<unknown>): { outcome: string | null } {
    const result = { outcome: null as string | null };
    promise.then(
      () => {
        result.outcome = 'resolved';
      },
      (err: unknown) => {
        result.outcome = err instanceof Error ? err.message : String(err);
      },
    );
    return result;
  }

  it('As a dotli integrator, I follow the protocol status from idle to ready, and subscribing starts no frame', async () => {
    // Given
    const statuses: ProtocolStatus[] = [];
    host.client.subscribeProtocolStatus(status => statuses.push(status));
    await advance();
    const framesBeforeAsking = host.frames();

    // When
    void host.client.ensureProtocolFrame();
    await bringUp(host);

    // Then
    expect(framesBeforeAsking).toBe(0);
    expect(statuses).toEqual(['booting', 'listening', 'ready']);
    expect(host.client.getProtocolStatus()).toBe('ready');
  });

  it('As a dotli user whose protocol frame fails its init, I see it reported failed and then rebuilt', async () => {
    // Given
    void host.client.ensureProtocolFrame().catch(() => undefined);
    const status = await listen(host);
    const dead = host.iframe();

    // When
    status.fail(new ProtocolInitFailedError('no SharedWorker'));
    await advance();
    const statusAfterFailure = host.client.getProtocolStatus();
    await advance(2_000);
    await bringUp(host);

    // Then
    expect(statusAfterFailure).toBe('failed');
    expect(dead.isConnected).toBe(false);
    expect(host.iframe()).not.toBe(dead);
    expect(host.client.getProtocolStatus()).toBe('ready');
  });

  it('As a dotli user, I make a request while the protocol frame boots and it waits, then fails as soon as that boot fails', async () => {
    // Given
    const warmup = settledWith(host.client.warmupProtocol());
    const status = await listen(host);
    const waitingWhileBooting = warmup.outcome;

    // When
    status.fail(new ProtocolInitFailedError('bad network'));
    await advance();

    // Then
    expect(waitingWhileBooting).toBeNull();
    expect(warmup.outcome).toBe('bad network');
  });

  it('As a returning user whose protocol frame never reports ready, I get a rebuilt frame and my shared store back', async () => {
    // Given
    const statuses: SharedStoreStatus[] = [];
    host.client.subscribeSharedStoreStatus(status => statuses.push(status));
    const warmup = settledWith(host.client.warmupProtocol());
    await listen(host);
    const dead = host.iframe();

    // When
    await advance(READY_TIMEOUT_MS);
    await advance(2_000);
    await listen(host);

    // Then
    expect(warmup.outcome).toBe(PROTOCOL_ERRORS.FRAME_READY_TIMEOUT);
    expect(dead.isConnected).toBe(false);
    expect(statuses).toEqual(['available', 'unavailable', 'available']);
  });

  it('As a dotli user whose light client dies soon after each rebuild, I wait longer before each new frame', async () => {
    // Given a frame that comes up and dies at once
    void host.client.ensureProtocolFrame();
    let status = await bringUp(host);
    const rebuildsAfter: number[] = [];

    // When each rebuild comes up and dies at once too
    for (let i = 0; i < 3; i++) {
      status.fail(new ProtocolFatalError('boom'));
      await advance();
      let waited = 0;
      while (host.frames() === 0 && waited < 60_000) {
        await advance(1_000);
        waited += 1_000;
      }
      expect(host.frames()).toBe(1);
      rebuildsAfter.push(waited);
      status = await bringUp(host);
    }

    // Then
    expect(rebuildsAfter).toEqual([2_000, 4_000, 8_000]);
  });

  it('As a dotli user whose protocol frame stayed up past 30 s, I get its rebuild after 2 s again', async () => {
    // Given two quick deaths grew the wait, then a frame stayed up 30 s
    void host.client.ensureProtocolFrame();
    let status = await bringUp(host);
    status.fail(new ProtocolFatalError('boom'));
    await advance(2_000);
    status = await bringUp(host);
    status.fail(new ProtocolFatalError('boom'));
    await advance(4_000);
    status = await bringUp(host);
    await advance(30_000);

    // When
    status.fail(new ProtocolFatalError('boom'));
    await advance(1_999);
    const framesBeforeWait = host.frames();
    await advance(1);

    // Then
    expect(framesBeforeWait).toBe(0);
    expect(host.frames()).toBe(1);
  });

  it('As a returning user, I change the frame config during my session and see the shared store down, then available', async () => {
    // Given
    void host.client.ensureProtocolFrame();
    await bringUp(host);
    const statuses: SharedStoreStatus[] = [];
    host.client.subscribeSharedStoreStatus(status => statuses.push(status));

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await listen(host);

    // Then
    expect(statuses).toEqual(['unavailable', 'available']);
  });

  it('As a dotli integrator, I change the frame config and the chain connections of the dropped frame halt', async () => {
    // Given a chain connection the frame accepted
    const provider = host.client.createRemoteChainProvider(getActiveServicesConfig().people.genesis);
    if (provider === null) {
      throw new Error('People is not remote-connectable');
    }
    const onHalt: Mock<(reason: RemoteChainHalt) => void> = vi.fn<(reason: RemoteChainHalt) => void>();
    provider(() => undefined, onHalt);
    host.serve().handleSubscription('chainConnect', (_payload, _context, sink) => {
      sink.send({ tag: 'connected', value: undefined });
      return () => undefined;
    });
    await bringUp(host);

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });

    // Then
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledWith('frame');
  });

  it('As a dotli user, I change the frame config and a late fatal from the dropped frame does not fail the rebuild', async () => {
    // Given the dropped frame's fatal is sent while the client has no frame
    void host.client.ensureProtocolFrame();
    const deadStatus = await bringUp(host);
    host.client.subscribeProtocolStatus(next => {
      if (next === 'idle') {
        deadStatus.fail(new ProtocolFatalError('late'));
      }
    });

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const read = settledWith(host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY));
    host.serve().handleRequest('authStorageRead', () => new Promise<null>(() => undefined));
    await listen(host);

    // Then
    expect(host.client.getProtocolStatus()).toBe('listening');
    expect(read.outcome).toBeNull();
    expect(sent(host.iframe())).toEqual(['subscribe:frameStatus', 'subscribe:telemetry', 'request:authStorageRead']);
  });

  it('As a dotli integrator, I request from a status listener after a config change and see the statuses in order', async () => {
    // Given
    void host.client.ensureProtocolFrame();
    await bringUp(host);
    const heard: ProtocolStatus[][] = [[], []];
    let request: Promise<void> | null = null;
    host.client.subscribeProtocolStatus(next => {
      heard[0]?.push(next);
      if (next === 'idle' && request === null) {
        request = host.client.ensureProtocolFrame();
      }
    });
    host.client.subscribeProtocolStatus(next => heard[1]?.push(next));

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const framesAfterChange = host.frames();
    await bringUp(host);

    // Then
    expect(framesAfterChange).toBe(1);
    expect(heard[0]).toEqual(['idle', 'booting', 'listening', 'ready']);
    expect(heard[1]).toEqual(['idle', 'booting', 'listening', 'ready']);
    await expect(request).resolves.toBeUndefined();
  });

  it('As a dotli integrator, I request from an idle listener during a config change and the frame keeps one keeper', async () => {
    // Given a second keeper would wait behind the first and rebuild the next lost frame at once
    void host.client.ensureProtocolFrame();
    await bringUp(host);
    host.client.subscribeProtocolStatus(next => {
      if (next === 'idle') {
        void host.client.ensureProtocolFrame().catch(() => undefined);
      }
    });
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const status = await bringUp(host);

    // When
    status.fail(new ProtocolFatalError('boom'));
    await advance(1_999);
    const framesBeforeWait = host.frames();
    await advance(1);

    // Then
    expect(framesBeforeWait).toBe(0);
    expect(host.frames()).toBe(1);
  });

  it('As a dotli user whose frame cannot be built, I see the real error on each request, each request that finds it down builds one, and one keeper retries', async () => {
    // Given
    let builds = 0;
    const dom = createFrameDom(undefined, { timers });
    const failing = createProtocolClient({
      ...dom.deps,
      document: {
        createElement: () => {
          builds += 1;
          throw new Error('no iframe here');
        },
        body: dom.deps.document.body,
      },
    });
    failing.configureProtocolFrame(FRAME_CONFIG);

    // When the first build fails in the turn it is asked for, so the second request finds the frame down and boots
    // its own
    const first = settledWith(failing.ensureProtocolFrame());
    const second = settledWith(failing.ensureProtocolFrame());
    await advance();
    const buildsAfterRequests = builds;
    await advance(2_000);

    // Then
    expect(first.outcome).toBe('no iframe here');
    expect(second.outcome).toBe('no iframe here');
    expect(buildsAfterRequests).toBe(2);
    expect(builds).toBe(3);
  });

  class FrameBuildError extends Error {
    override name = 'FrameBuildError';
  }

  it.each([
    { thrown: 'no iframe here', reason: 'unknown', what: 'a string' },
    { thrown: new FrameBuildError('no iframe here'), reason: 'FrameBuildError', what: 'an error class' },
  ])(
    'As a dotli operator, I see a frame that fails to build counted by what it threw ($what) and not by a wrapper',
    async ({ thrown, reason }) => {
      // Given a frame whose iframe cannot be built, and a recording metrics pipeline
      const metrics = bindRecordingSentry({ onFinished: onTestFinished });
      const dom = createFrameDom(undefined, { timers });
      const failing = createProtocolClient({
        ...dom.deps,
        document: {
          createElement: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- a thrown non-Error is the case under test
            throw thrown;
          },
          body: dom.deps.document.body,
        },
      });
      failing.configureProtocolFrame(FRAME_CONFIG);

      // When the first build fails
      void settledWith(failing.ensureProtocolFrame());
      await advance();

      // Then the failure is counted with the reason of the thrown value
      expect(metrics.counted(S.PROTOCOL_IFRAME_READY)).toContainEqual({ outcome: 'error', phase: 'load', reason });
    },
  );

  it('As a dotli user, I change the config during the wait before a rebuild and get a frame at once, and the dropped wait leaves no second rebuild', async () => {
    // Given a retry left over from the dropped wait would rebuild the next lost frame at once
    void host.client.ensureProtocolFrame();
    let status = await bringUp(host);
    status.fail(new ProtocolFatalError('boom'));
    await advance(1_000);

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const mode = new URL(host.iframe().src).searchParams.get('mode');
    status = await bringUp(host);
    status.fail(new ProtocolFatalError('boom'));
    await advance(1_999);
    const framesBeforeWait = host.frames();
    await advance(1);

    // Then
    expect(mode).toBe('rpc');
    expect(framesBeforeWait).toBe(0);
    expect(host.frames()).toBe(1);
  });

  it('As a dotli integrator, I change the config and request from a failed listener and the request resolves', async () => {
    // Given
    void host.client.ensureProtocolFrame();
    const status = await bringUp(host);
    let request: Promise<void> | null = null;
    host.client.subscribeProtocolStatus(next => {
      if (next === 'failed' && request === null) {
        host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
        request = host.client.ensureProtocolFrame();
      }
    });

    // When
    status.fail(new ProtocolFatalError('boom'));
    await advance();
    await bringUp(host);

    // Then
    await expect(request).resolves.toBeUndefined();
    expect(host.client.getProtocolStatus()).toBe('ready');
  });

  it('As a dotli integrator, I change the config from a booting listener and one frame is kept, built with the new config', async () => {
    // Given
    let changes = 0;
    host.client.subscribeProtocolStatus(next => {
      if (next === 'booting' && changes === 0) {
        changes += 1;
        host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
      }
    });

    // When
    void host.client.ensureProtocolFrame().catch(() => undefined);
    const framesAfterChange = host.frames();
    const mode = new URL(host.iframe().src).searchParams.get('mode');
    void host.client.ensureProtocolFrame();
    await bringUp(host);

    // Then
    expect(framesAfterChange).toBe(1);
    expect(mode).toBe('rpc');
    expect(host.client.getProtocolStatus()).toBe('ready');
  });

  it('As a dotli integrator, a status listener that throws is reported and counted, and the next listener still hears the change', async () => {
    // Given a first listener that throws on every change, and a reporting pipeline that records captures and counts
    const captures: { step: string; tags: Record<string, string> | undefined }[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: (_err, ctx) => {
          captures.push({ step: ctx.step, tags: ctx.tags });
        },
        expected: () => undefined,
      }),
    );
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    host.client.subscribeProtocolStatus(() => {
      throw new Error('listener broke');
    });
    const heard: ProtocolStatus[] = [];
    host.client.subscribeProtocolStatus(next => heard.push(next));

    // When
    void host.client.ensureProtocolFrame();
    await listen(host);

    // Then the next listener heard each change, and each throw was captured once and counted once
    expect(heard).toEqual(['booting', 'listening']);
    expect(captures).toEqual([
      { step: 'listener', tags: { owner: 'protocol.status' } },
      { step: 'listener', tags: { owner: 'protocol.status' } },
    ]);
    expect(metrics.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'protocol.status' },
      { outcome: 'error', reason: 'Error', owner: 'protocol.status' },
    ]);
  });

  it('As a dotli integrator, I unsubscribe a listener from another listener and it hears nothing after that', async () => {
    // Given
    void host.client.ensureProtocolFrame();
    const status = await bringUp(host);
    const heard: ProtocolStatus[] = [];
    let unsubscribe: (() => void) | null = null;
    host.client.subscribeProtocolStatus(next => {
      if (next === 'failed') {
        host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
        unsubscribe?.();
      }
    });
    unsubscribe = host.client.subscribeProtocolStatus(next => heard.push(next));

    // When
    status.fail(new ProtocolFatalError('boom'));
    await advance();

    // Then
    expect(heard).toEqual(['failed']);
  });
});

describe('backendOfFrameMode', () => {
  it('As the protocol frame, I read each backend from the word a host page of any release puts in my URL, and no other word', () => {
    // When
    const read = ['shared-worker', 'direct', 'rpc', 'smoldot-direct', ''].map(backendOfFrameMode);

    // Then
    expect(read).toEqual(['smoldot-shared-worker', 'smoldot-direct', 'rpc-gateway', null, null]);
  });
});
