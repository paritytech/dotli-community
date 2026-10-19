// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { getActiveServicesConfig, SITE_ID } from '@dotli/config';
import { bindCaptureSink, spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { deferred, toError } from '@dotli/shared';
import { manualTimers, recordLog, type ManualTimers } from '@dotli/shared/testing';
import { domain, err, ok } from '@dotli/transport';
import { recordMessage } from '@dotli/transport/testing';
import type { RemoteChainHalt } from '@dotli/chains';
import { SHARED_CORE_SESSION_KEY } from './auth-storage.js';
import { createProtocolClient } from './client.js';
import {
  PROTOCOL_ERRORS,
  ProtocolFatalError,
  ProtocolHandshakeTimeoutError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolVersionMismatchError,
} from './errors.js';
import { backendOfFrameMode, createProtocolFrame, type ProtocolFrame, type ProtocolStatus } from './frame.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';
import type { SharedStoreStatus } from './shared-store.js';
import { createFrameDom, createFrameHost, FRAME_CONFIG, type FrameDom, type FrameHost } from './testing/frame-host.js';

const { resolve, storage, chain } = protocolSchema.sections;

const HANDSHAKE_TIMEOUT_MS = 5_000;
const READY_TIMEOUT_MS = 240_000;

/** The clock and timers each test moves by hand. */
let timers: ManualTimers;

beforeEach(() => {
  timers = manualTimers();
});

const advance = (ms = 0): Promise<void> => timers.advance(ms);

/** The frame's transport once its handshake is done, which is how the shared store waits for a listening frame. */
async function whenListening(frame: ProtocolFrame): Promise<ProtocolTransport> {
  const transport = await frame.transport();
  await transport.whenConnected();
  return transport;
}

/**
 * What a frame app sends the host once its light client is ready, recorded from a frame of its own that went through
 * the same steps, so the bytes would be heard from the right frame.
 */
async function recordedReady(): Promise<ArrayBuffer[]> {
  const other = createFrameDom(undefined, { timers });
  const frame = createProtocolFrame(other.deps);
  frame.configure(FRAME_CONFIG);
  void frame.transport();
  const status = await other.listen();
  status.ready();
  await advance();
  return other
    .iframe()
    .window.sent.flatMap(data =>
      data instanceof ArrayBuffer && recordMessage(protocolSchema, data)?.tag === 'receive' ? [data] : [],
    );
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
    // Given what a frame says when its light client is ready, a listening frame, and another iframe on the page
    const ready = await recordedReady();
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.transport();
    await dom.listen();
    const stranger = dom.stranger();

    // When the other iframe, and the frame from another origin, say the light client is ready
    for (const data of ready) {
      dom.deliverRaw(data, stranger);
      dom.deliverRaw(data, dom.iframe(), 'https://evil.example');
    }
    await advance();
    const afterStrangers = frame.getStatus();
    for (const data of ready) {
      dom.deliverRaw(data);
    }
    await advance();

    // Then
    expect(ready).toHaveLength(1);
    expect(afterStrangers).toBe('listening');
    expect(frame.getStatus()).toBe('ready');
  });

  it('As a dotli operator, I see each message the frame sends that the host cannot read counted once as refused', async () => {
    // Given a listening frame, and a log of the host's breadcrumbs
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const events = recordLog({ onFinished: onTestFinished, level: 'info' });
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.transport();
    await dom.listen();

    // When the frame sends bytes too short to be a message, and an object as a frame of an earlier release does
    dom.deliverRaw(new Uint8Array([0xff, 0xff, 0xff]).buffer);
    dom.deliverRaw({ namespace: 'dotli:protocol', kind: 'ready' });
    await advance();

    // Then
    expect(metrics.counted(S.PROTOCOL_WIRE_REFUSED)).toEqual([
      { outcome: 'refused', reason: 'malformed', side: 'host' },
      { outcome: 'refused', reason: 'not_bytes', side: 'host' },
    ]);
    expect(
      events
        .filter(line => line.message === 'protocol message refused')
        .map(({ message, attrs }) => ({ message, attrs })),
    ).toEqual([
      {
        message: 'protocol message refused',
        attrs: { flow: 'protocol', reason: 'malformed', side: 'host', cause: expect.any(String) as string },
      },
      { message: 'protocol message refused', attrs: { flow: 'protocol', reason: 'not_bytes', side: 'host' } },
    ]);
    expect(frame.getStatus()).toBe('listening');
  });

  it('As the host, I start my handshake on the frame load', async () => {
    // Given a frame whose document has not loaded yet
    const dom = createFrameDom(undefined, { mount: null, timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    const up = whenListening(frame);
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
    void whenListening(frame).then(() => settled.push('listening'));
    void frame.whenReady().then(() => settled.push('ready'));

    // When
    const status = await dom.listen();
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
    await dom.bringUp();

    // Then
    expect(framesBeforeAsking).toBe(0);
    expect(dom.frames()).toBe(1);
    expect(second).toBe(first);
    await expect(frame.whenReady()).resolves.toBe(first);
  });

  it('As the host with an app open, I hear a version mismatch once the frame status says it is down', async () => {
    // Given a frame waiting on its handshake, and a listener that reads the status when it hears the mismatch
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenReady().catch(() => undefined);
    await advance();
    const heard: { name: string; status: ProtocolStatus }[] = [];
    frame.onVersionMismatch(error => heard.push({ name: error.name, status: frame.getStatus() }));

    // When the frame refuses the host wire version
    dom.serveNewer();
    await dom.retryHandshake();

    // Then
    expect(heard).toEqual([{ name: 'ProtocolVersionMismatchError', status: 'failed' }]);
  });

  it('As a dotli integrator, I wait on a frame before it is configured, and it boots and answers once configured', async () => {
    // Given
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    const up = whenListening(frame);
    await advance();
    const framesBeforeConfig = dom.frames();

    // When
    frame.configure(FRAME_CONFIG);
    await advance();
    await dom.listen();

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
    const up = frame.whenReady().catch((err: unknown) => err);
    dom.status().fail(new ProtocolInitFailedError('no SharedWorker'));

    // When
    await dom.retryHandshake();
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
    void frame.whenReady().catch(() => undefined);
    const status = await dom.listen();
    dom.serve().handleRequest(resolve.owner, () => new Promise(() => undefined));
    const transport = await frame.transport();
    const owner = transport.request(resolve.owner, { label: 'doom' }).then(() => null, toError);
    await advance();

    // When its light client dies, which ends its status, and the loss disposes its transport
    status.fail(new ProtocolFatalError('boom'));
    await advance();

    // Then
    expect(await owner).toBeInstanceOf(ProtocolFatalError);
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
    void frame.whenReady().catch(() => undefined);
    const status = await dom.bringUp();

    // When its light client dies
    status.fail(new ProtocolFatalError('boom'));
    await advance();

    // Then
    expect(metrics.counted(S.PROTOCOL_FRAME_LOST)).toEqual([{ outcome: 'error', reason: 'ProtocolFatalError' }]);
    expect(metrics.counted(S.PROTOCOL_IFRAME_READY).filter(tags => tags?.['outcome'] === 'error')).toEqual([]);
    expect(captured).toEqual([{ flow: 'protocol', step: 'frame_lost' }]);
  });

  it('As the host, ready frames that keep dying are each counted, captured once, and captured again after a stable one', async () => {
    // Given a ready frame, and a reporting pipeline that records captures and counts
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenReady().catch(() => undefined);
    const first = await dom.bringUp();

    // When it dies soon after ready, and so does the frame rebuilt after the backoff
    first.fail(new ProtocolFatalError('boom'));
    await advance(2_000);
    const second = await dom.bringUp();
    second.fail(new ProtocolFatalError('boom'));
    await advance(4_000);

    // Then both losses are counted and only the first is captured
    expect(metrics.counted(S.PROTOCOL_FRAME_LOST)).toHaveLength(2);
    expect(captured).toEqual([{ flow: 'protocol', step: 'frame_lost' }]);

    // When the next frame stays ready for the stable span before it dies
    const third = await dom.bringUp();
    await advance(30_000);
    third.fail(new ProtocolFatalError('boom'));
    await advance();

    // Then its loss is counted and captured again
    expect(metrics.counted(S.PROTOCOL_FRAME_LOST)).toHaveLength(3);
    expect(captured).toEqual([
      { flow: 'protocol', step: 'frame_lost' },
      { flow: 'protocol', step: 'frame_lost' },
    ]);
  });

  it('As the host, a worker port release ends the frame without capturing it, through the typed released interrupt', async () => {
    // Given a ready frame, and a reporting pipeline that records captures, counts and breadcrumbs
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const events = recordLog({ onFinished: onTestFinished, level: 'info' });
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenReady().catch(() => undefined);
    const status = await dom.bringUp();
    const transport = await frame.transport();
    dom.serve().handleRequest(resolve.owner, () => new Promise(() => undefined));
    const owner = transport.request(resolve.owner, { label: 'doom' }).then(() => null, toError);
    await advance();

    // When the tab thaws and finds the SharedWorker let go of its port
    status.interrupt(err(domain({ tag: 'released', value: 'The worker released this tab' })));
    await advance();

    // Then
    expect(metrics.counted(S.PROTOCOL_FRAME_LOST)).toEqual([{ outcome: 'error', reason: 'ProtocolPortReleasedError' }]);
    expect(captured).toEqual([]);
    expect(events.map(line => line.message)).toContain('protocol frame released');
    expect(await owner).toBeInstanceOf(ProtocolPortReleasedError);
    expect((await owner)?.message).toBe('The worker released this tab');
    expect(frame.getStatus()).toBe('failed');
  });

  it('As the host, a frame that ends its status cleanly is lost as one that stopped reporting it', async () => {
    // Given a ready frame, with a request out on its transport
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenReady().catch(() => undefined);
    const status = await dom.bringUp();
    const transport = await frame.transport();
    dom.serve().handleRequest(resolve.owner, () => new Promise(() => undefined));
    const owner = transport.request(resolve.owner, { label: 'doom' }).then(() => null, toError);
    await advance();

    // When the frame ends its status with no failure
    status.interrupt(ok());
    await advance();

    // Then
    expect((await owner)?.message).toBe(PROTOCOL_ERRORS.FRAME_STATUS_ENDED);
    expect(metrics.counted(S.PROTOCOL_FRAME_LOST)).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(frame.getStatus()).toBe('failed');
  });

  it('As the host, a late message from a dropped frame settles nothing on the new one', async () => {
    // Given a read the first frame holds while it is dropped
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    void frame.whenReady().catch(() => undefined);
    const first = dom.iframe();
    const held = deferred<string | null>();
    dom.serve(first).handleRequest(storage.authRead, () => held.promise.then(value => ok(value)));
    const firstStatus = await dom.bringUp();
    const firstTransport = await frame.transport();
    // Enough reads that their ids reach past the one the rebuilt frame's read gets
    const oldReads = Array.from({ length: 16 }, () =>
      firstTransport.request(storage.authRead, { siteId: SITE_ID, key: 'k' }).then(() => null, toError),
    );
    await advance();
    firstStatus.fail(new ProtocolFatalError('boom'));
    await advance();

    // And a read on the rebuilt frame, which it never answers
    const rebuilt = await frame.transport();
    dom.serve().handleRequest(storage.authRead, () => new Promise(() => undefined));
    await dom.bringUp();
    const answered: boolean[] = [];
    void rebuilt.request(storage.authRead, { siteId: SITE_ID, key: 'k' }).then(answer => answered.push(answer.success));
    await advance();

    // When the dropped frame answers every read late
    held.resolve('stale');
    await advance();

    // Then
    expect(answered).toEqual([]);
    expect(
      first.window.sent.filter(
        data => data instanceof ArrayBuffer && recordMessage(protocolSchema, data)?.section === 'storage',
      ),
    ).toHaveLength(16);
    for (const read of oldReads) {
      expect(await read).toMatchObject({ message: 'boom' });
    }
    expect(frame.getStatus()).toBe('ready');
  });

  it('As the host, a version mismatch is final', async () => {
    // Given a frame of another release, which refuses the host wire version
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom(undefined, { timers });
    const frame = createProtocolFrame(dom.deps);
    frame.configure(FRAME_CONFIG);
    const up = frame.whenReady().catch((err: unknown) => err);
    await advance();

    // When
    dom.serveNewer();
    await dom.retryHandshake();
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
    await expect(frame.whenReady()).rejects.toBeInstanceOf(ProtocolVersionMismatchError);
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
    void frame.whenReady().catch(() => undefined);
    const status = await dom.bringUp();
    const heard: Error[] = [];
    frame.onVersionMismatch(error => heard.push(error));

    // When the frame is lost, and the frame rebuilt after the backoff refuses the host wire version
    status.fail(new ProtocolFatalError('boom'));
    await advance(2_000);
    dom.serveNewer();
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
    const up = frame.whenReady().catch((err: unknown) => err);
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
    const up = outcomeOf(whenListening(frame));
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
    const up = frame.whenReady();
    const status = await dom.bringUp();
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
    const up = outcomeOf(frame.whenReady());
    const framesAfterAsking = dom.frames();
    await dom.bringUp();

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
    const up = outcomeOf(frame.whenReady());
    const status = await dom.listen();
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
    const up = frame.whenReady();
    const firstStatus = await dom.bringUp();
    await up;
    firstStatus.fail(new ProtocolFatalError('boom'));
    await advance();
    const buildsBeforeAsking = builds;

    // When
    const first = outcomeOf(frame.whenReady());
    const second = outcomeOf(whenListening(frame));
    const framesAfterAsking = dom.frames();
    const status = await dom.listen();
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
    const first = outcomeOf(frame.whenReady());
    const second = outcomeOf(whenListening(frame));
    const rebuilt = dom.iframe();
    const framesAfterAsking = dom.frames();
    await dom.bringUp();
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
    await host.bringUp();

    // Then
    expect(framesBeforeAsking).toBe(0);
    expect(statuses).toEqual(['booting', 'listening', 'ready']);
    expect(host.client.getProtocolStatus()).toBe('ready');
  });

  it('As a dotli user whose protocol frame fails its init, I see it reported failed and then rebuilt', async () => {
    // Given
    void host.client.ensureProtocolFrame().catch(() => undefined);
    const status = await host.listen();
    const dead = host.iframe();

    // When
    status.fail(new ProtocolInitFailedError('no SharedWorker'));
    await advance();
    const statusAfterFailure = host.client.getProtocolStatus();
    await advance(2_000);
    await host.bringUp();

    // Then
    expect(statusAfterFailure).toBe('failed');
    expect(dead.isConnected).toBe(false);
    expect(host.iframe()).not.toBe(dead);
    expect(host.client.getProtocolStatus()).toBe('ready');
  });

  it('As a dotli user, I make a request while the protocol frame boots and it waits, then fails as soon as that boot fails', async () => {
    // Given
    const warmup = settledWith(host.client.warmupProtocol());
    const status = await host.listen();
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
    await host.listen();
    const dead = host.iframe();

    // When
    await advance(READY_TIMEOUT_MS);
    await advance(2_000);
    await host.listen();

    // Then
    expect(warmup.outcome).toBe(PROTOCOL_ERRORS.FRAME_READY_TIMEOUT);
    expect(dead.isConnected).toBe(false);
    expect(statuses).toEqual(['available', 'unavailable', 'available']);
  });

  it('As a dotli user whose light client dies soon after each rebuild, I wait longer before each new frame', async () => {
    // Given a frame that comes up and dies at once
    void host.client.ensureProtocolFrame();
    let status = await host.bringUp();
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
      status = await host.bringUp();
    }

    // Then
    expect(rebuildsAfter).toEqual([2_000, 4_000, 8_000]);
  });

  it('As a dotli user whose protocol frame stayed up past 30 s, I get its rebuild after 2 s again', async () => {
    // Given two quick deaths grew the wait, then a frame stayed up 30 s
    void host.client.ensureProtocolFrame();
    let status = await host.bringUp();
    status.fail(new ProtocolFatalError('boom'));
    await advance(2_000);
    status = await host.bringUp();
    status.fail(new ProtocolFatalError('boom'));
    await advance(4_000);
    status = await host.bringUp();
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
    await host.bringUp();
    const statuses: SharedStoreStatus[] = [];
    host.client.subscribeSharedStoreStatus(status => statuses.push(status));

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await host.listen();

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
    host.serve().handleSubscription(chain.connect, (_start, _context, sink) => {
      sink.send({ tag: 'connected', value: undefined });
      return () => undefined;
    });
    await host.bringUp();

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });

    // Then
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledWith('frame');
  });

  it('As a dotli user, I change the frame config and a late fatal from the dropped frame does not fail the rebuild', async () => {
    // Given the dropped frame's fatal is sent while the client has no frame
    void host.client.ensureProtocolFrame();
    const deadStatus = await host.bringUp();
    host.client.subscribeProtocolStatus(next => {
      if (next === 'idle') {
        deadStatus.fail(new ProtocolFatalError('late'));
      }
    });

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const read = settledWith(host.client.readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY));
    host.serve().handleRequest(storage.authRead, () => new Promise(() => undefined));
    await host.listen();

    // Then
    expect(host.client.getProtocolStatus()).toBe('listening');
    expect(read.outcome).toBeNull();
    expect(host.sent().map(message => `${message.tag}:${message.section}.${message.method}`)).toEqual([
      'start:frame.status',
      'start:frame.telemetry',
      'request:storage.authRead',
    ]);
  });

  it('As a dotli integrator, I request from a status listener after a config change and see the statuses in order', async () => {
    // Given
    void host.client.ensureProtocolFrame();
    await host.bringUp();
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
    await host.bringUp();

    // Then
    expect(framesAfterChange).toBe(1);
    expect(heard[0]).toEqual(['idle', 'booting', 'listening', 'ready']);
    expect(heard[1]).toEqual(['idle', 'booting', 'listening', 'ready']);
    await expect(request).resolves.toBeUndefined();
  });

  it('As a dotli integrator, I request from an idle listener during a config change and the frame keeps one keeper', async () => {
    // Given a second keeper would wait behind the first and rebuild the next lost frame at once
    void host.client.ensureProtocolFrame();
    await host.bringUp();
    host.client.subscribeProtocolStatus(next => {
      if (next === 'idle') {
        void host.client.ensureProtocolFrame().catch(() => undefined);
      }
    });
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const status = await host.bringUp();

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
    let status = await host.bringUp();
    status.fail(new ProtocolFatalError('boom'));
    await advance(1_000);

    // When
    host.client.configureProtocolFrame({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const mode = new URL(host.iframe().src).searchParams.get('mode');
    status = await host.bringUp();
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
    const status = await host.bringUp();
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
    await host.bringUp();

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
    await host.bringUp();

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
    await host.listen();

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
    const status = await host.bringUp();
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
