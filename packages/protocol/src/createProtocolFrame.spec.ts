// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { getActiveServicesConfig, SITE_ID } from '@dotli/config';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { createDeferred, toError } from '@dotli/shared';
import { catchRejection, createManualTimers, readOutcome, recordLog, type ManualTimers } from '@dotli/shared/testing';
import { domain, err, ok } from '@dotli/transport';
import { recordMessage } from '@dotli/transport/testing';
import type { RemoteChainHalt } from '@dotli/chains';
import { createProtocolClient } from './createProtocolClient.js';
import { DEFAULT_FRAME_TIMEOUTS, createProtocolFrame } from './createProtocolFrame.js';
import type { SharedStoreStatus } from './createSharedStore.js';
import {
  PROTOCOL_ERRORS,
  ProtocolFatalError,
  ProtocolHandshakeTimeoutError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolVersionMismatchError,
} from './errors.js';
import type { ProtocolFrame, ProtocolStatus } from './frameTypes.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';
import { SHARED_CORE_SESSION_KEY } from './sharedAuthKeys.js';
import { FRAME_CONFIG } from './testing/constants.js';
import { createFrameDom, type FrameDom } from './testing/createFrameDom.js';
import { createFrameHost, type FrameHost } from './testing/createFrameHost.js';

const { resolve, storage, chain } = protocolSchema.sections;
const { heartbeat } = protocolSchema.sections.frame;

const HANDSHAKE_TIMEOUT_MS = DEFAULT_FRAME_TIMEOUTS.handshakeMs;
/** What the frame reports when a status listener throws. */
const STATUS_LISTENER_CAPTURE = { flow: 'protocol', step: 'listener', tags: { owner: 'protocol.status' } };
const STATUS_LISTENER_REPORT = { outcome: 'error', reason: 'Error', owner: 'protocol.status' };
const READY_TIMEOUT_MS = 240_000;

/** The clock and timers each test moves by hand. */
let timers: ManualTimers;

beforeEach(() => {
  timers = createManualTimers();
});

function advance(ms = 0): Promise<void> {
  return timers.advance(ms);
}

/** The frame's transport once its handshake is done, which is how the shared store waits for a listening frame. */
async function waitForListening(frame: ProtocolFrame): Promise<ProtocolTransport> {
  const transport = await frame.getTransport();
  await transport.whenConnected();
  return transport;
}

/**
 * What a frame app sends the host once its light client is ready, recorded from a frame of its own that went through
 * the same steps, so the bytes would be heard from the right frame.
 */
async function recordReady(): Promise<ArrayBuffer[]> {
  const other = createFrameDom({ timers });
  const frame = createProtocolFrame(other.params);
  frame.configure(FRAME_CONFIG);
  void frame.getTransport();
  const status = await other.listen();
  status.markReady();
  await advance();
  return other
    .getIframe()
    .window.sent.flatMap(data =>
      data instanceof ArrayBuffer && recordMessage(protocolSchema, data)?.tag === 'receive' ? [data] : [],
    );
}

describe('protocol frame location', () => {
  it('As a host page, I load the frame and it opens at its path with the query', () => {
    // Given a configured frame
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);

    // When the page asks for its transport
    void frame.getTransport().catch(() => undefined);

    // Then the iframe loads the protocol path with the mode and network
    expect(dom.getIframe().src).toBe('https://dot.li/p/?mode=direct&network=paseo-next-v2');
  });
});

describe('createProtocolFrame', () => {
  it('As a dotli integrator, I hear only what the current frame sends from its origin', async () => {
    // Given what a frame says when its light client is ready, a listening frame, and another iframe on the page
    const ready = await recordReady();
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.getTransport();
    await dom.listen();
    const stranger = dom.mountStranger();

    // When the other iframe, and the frame from another origin, say the light client is ready
    for (const data of ready) {
      dom.deliverRaw(data, { from: stranger });
      dom.deliverRaw(data, { origin: 'https://evil.example' });
    }
    await advance();
    const afterStrangers = frame.status.get();
    for (const data of ready) {
      dom.deliverRaw(data);
    }
    await advance();

    // Then
    expect(ready).toHaveLength(1);
    expect(afterStrangers).toBe('listening');
    expect(frame.status.get()).toBe('ready');
  });

  it('As a dotli operator, I see each message the frame sends that the host cannot read counted once as refused', async () => {
    // Given a listening frame, and a log of the host's breadcrumbs
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const events = recordLog({ onFinished: onTestFinished, level: 'info' });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.getTransport();
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
        // An asymmetric matcher is typed any.
        attrs: { flow: 'protocol', reason: 'malformed', side: 'host', cause: expect.any(String) as string },
      },
      { message: 'protocol message refused', attrs: { flow: 'protocol', reason: 'not_bytes', side: 'host' } },
    ]);
    expect(frame.status.get()).toBe('listening');
  });

  it('As the host, I start my handshake on the frame load', async () => {
    // Given a frame whose document has not loaded yet
    const dom = createFrameDom({ mount: null, timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    const up = waitForListening(frame);
    dom.getFrameStatus();
    await advance(1_000);
    const postedBeforeLoad = dom.getIframe().window.posted.length;

    // When
    dom.getIframe().dispatchEvent(new Event('load'));
    await advance();

    // Then
    expect(postedBeforeLoad).toBe(0);
    await expect(up).resolves.toBe(await frame.getTransport());
    expect(frame.status.get()).toBe('listening');
  });

  it('As a dotli integrator, I wait for a listening frame without waiting for its light client', async () => {
    // Given
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    const settled: string[] = [];
    void waitForListening(frame).then(() => settled.push('listening'));
    void frame.waitUntilReady().then(() => settled.push('ready'));

    // When
    const status = await dom.listen();
    const afterListening = [...settled];
    status.markReady();
    await advance();

    // Then
    expect(afterListening).toEqual(['listening']);
    expect(settled).toEqual(['listening', 'ready']);
  });

  it('As a dotli integrator, I ask for the transport and get the current frame one, booting a frame if there is none', async () => {
    // Given
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    const framesBeforeAsking = dom.countFrames();

    // When
    const first = await frame.getTransport();
    const second = await frame.getTransport();
    await dom.bringUp();

    // Then
    expect(framesBeforeAsking).toBe(0);
    expect(dom.countFrames()).toBe(1);
    expect(second).toBe(first);
    await expect(frame.waitUntilReady()).resolves.toBe(first);
  });

  it('As the host with an app open, I hear a version mismatch once the frame status says it is down', async () => {
    // Given a frame waiting on its handshake, and a listener that reads the status when it hears the mismatch
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
    await advance();
    const heard: { name: string; status: ProtocolStatus }[] = [];
    frame.onVersionMismatch(error => heard.push({ name: error.name, status: frame.status.get() }));

    // When the frame refuses the host wire version
    dom.serveNewer();
    await dom.retryHandshake();

    // Then
    expect(heard).toEqual([{ name: 'ProtocolVersionMismatchError', status: 'failed' }]);
  });

  it('As the host with an app open, I hear a version mismatch although a status listener throws on the failed frame, and the throw is reported and no frame is rebuilt', async () => {
    // Given a frame waiting on its handshake, a status listener that throws on failed, and a mismatch listener
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
    await advance();
    const statuses: ProtocolStatus[] = [];
    onTestFinished(
      frame.status.listen(next => {
        statuses.push(next);
        if (next === 'failed') {
          throw new Error('listener broke');
        }
      }),
    );
    const heard: Error[] = [];
    frame.onVersionMismatch(error => heard.push(error));

    // When the frame refuses the host wire version, and the keeper's longest waits pass
    dom.serveNewer();
    await dom.retryHandshake();
    await advance(DEFAULT_FRAME_TIMEOUTS.maxRebuildMs * 3);

    // Then the mismatch was heard and stayed final, and the listener's throw was reported once
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeInstanceOf(ProtocolVersionMismatchError);
    expect(statuses).toEqual(['failed']);
    expect(frame.status.get()).toBe('failed');
    expect(dom.countFrames()).toBe(0);
    expect(captured).toEqual([STATUS_LISTENER_CAPTURE]);
    expect(metrics.counted(S.LISTENER_DELIVERY)).toEqual([STATUS_LISTENER_REPORT]);
  });

  it('As the host, I boot a frame while a status listener throws on booting, and the throw is reported and the boot goes on', async () => {
    // Given a configured frame, and a status listener that throws on booting
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    onTestFinished(
      frame.status.listen(next => {
        if (next === 'booting') {
          throw new Error('listener broke');
        }
      }),
    );

    // When the page asks for a frame, and the frame answers its handshake
    const loaded = frame.getTransport();
    await advance();
    await dom.listen();
    const transport = await frame.getTransport();

    // Then the boot went on to a listening frame, and the listener's throw was reported once
    await expect(loaded).resolves.toBe(transport);
    expect(frame.status.get()).toBe('listening');
    expect(dom.countFrames()).toBe(1);
    expect(metrics.counted(S.PROTOCOL_IFRAME_READY)).toEqual([]);
    expect(captured).toEqual([STATUS_LISTENER_CAPTURE]);
    expect(metrics.counted(S.LISTENER_DELIVERY)).toEqual([STATUS_LISTENER_REPORT]);
  });

  it('As a dotli integrator, I wait on a frame before it is configured, and it boots and answers once configured', async () => {
    // Given
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    const up = waitForListening(frame);
    await advance();
    const framesBeforeConfig = dom.countFrames();

    // When
    frame.configure(FRAME_CONFIG);
    await advance();
    await dom.listen();

    // Then
    expect(framesBeforeConfig).toBe(0);
    await expect(up).resolves.toBe(await frame.getTransport());
    expect(dom.countFrames()).toBe(1);
  });

  it('As the host, I subscribe the status of a frame that already failed and my boot fails, and the frame is rebuilt after the first wait', async () => {
    // Given a frame app whose light client failed before the host subscribed its status
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    const up = catchRejection(frame.waitUntilReady());
    dom.getFrameStatus().fail(new ProtocolInitFailedError('no SharedWorker'));

    // When
    await dom.retryHandshake();
    const failure = await up;
    const statusAfterFailure = frame.status.get();
    await advance(2_000);

    // Then
    expect(failure).toBeInstanceOf(ProtocolInitFailedError);
    expect(failure.message).toBe('no SharedWorker');
    expect(statusAfterFailure).toBe('failed');
    expect(metrics.counted(S.PROTOCOL_IFRAME_READY)).toEqual([
      { outcome: 'error', phase: 'ready', reason: 'ProtocolInitFailedError' },
    ]);
    expect(dom.countFrames()).toBe(1);
    expect(frame.status.get()).toBe('booting');
  });

  it('As the host, I drop a frame while a status listener throws, and the change returns, the throw is reported and the frame is still cleaned up', async () => {
    // Given a listening frame, and a status listener that throws when the frame goes idle
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.getTransport();
    await dom.listen();
    const dropped = dom.getIframe();
    onTestFinished(
      frame.status.listen(next => {
        if (next === 'idle') {
          throw new Error('listener broke');
        }
      }),
    );

    // When a config change drops the frame
    frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await advance();

    // Then the dropped iframe is gone, the frame is rebuilt with the new config, and the throw was reported once
    expect(dropped.isConnected).toBe(false);
    expect(dom.countFrames()).toBe(1);
    expect(new URL(dom.getIframe().src).searchParams.get('mode')).toBe('rpc');
    expect(captured).toEqual([STATUS_LISTENER_CAPTURE]);
    expect(metrics.counted(S.LISTENER_DELIVERY)).toEqual([STATUS_LISTENER_REPORT]);
  });

  it('As the host, I let a frame listen while a status listener throws on it, and the throw is reported and the frame stays up', async () => {
    // Given a booting frame, its transport, and a status listener that throws when the frame listens
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    const loaded = frame.getTransport();
    const booted = dom.getIframe();
    onTestFinished(
      frame.status.listen(next => {
        if (next === 'listening') {
          throw new Error('listener broke');
        }
      }),
    );

    // When the frame listens, and the rebuild wait passes
    await dom.listen();
    const connected = await readOutcome((await loaded).whenConnected());
    await advance(DEFAULT_FRAME_TIMEOUTS.rebuildMs);

    // Then the first frame is still the frame, listening, and the throw was reported once
    expect(connected).toBe('resolved');
    expect(booted.isConnected).toBe(true);
    expect(dom.countFrames()).toBe(1);
    expect(dom.getIframe()).toBe(booted);
    expect(frame.status.get()).toBe('listening');
    expect(captured).toEqual([STATUS_LISTENER_CAPTURE]);
    expect(metrics.counted(S.LISTENER_DELIVERY)).toEqual([STATUS_LISTENER_REPORT]);
  });

  it('As the host, I change a frame status that two listeners throw on, and the frame reports one throw and goes on', async () => {
    // Given a configured frame, and two status listeners that throw on booting
    const errors: unknown[] = [];
    const captured = recordCaptures({ onFinished: onTestFinished, errors });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    const first = new Error('first listener broke');
    const second = new Error('second listener broke');
    for (const thrown of [first, second]) {
      onTestFinished(
        frame.status.listen(next => {
          if (next === 'booting') {
            throw thrown;
          }
        }),
      );
    }

    // When the page asks for a frame, and the frame answers its handshake
    void frame.getTransport();
    await advance();
    await dom.listen();

    // Then the last throw alone was reported, and the boot went on to a listening frame
    expect(captured).toEqual([STATUS_LISTENER_CAPTURE]);
    expect(errors).toEqual([second]);
    expect(metrics.counted(S.LISTENER_DELIVERY)).toEqual([STATUS_LISTENER_REPORT]);
    expect(frame.status.get()).toBe('listening');
    expect(dom.countFrames()).toBe(1);
  });

  it('As the host, I lose a frame once and the loss is counted once', async () => {
    // Given a frame that listens, waiting for its light client, with a request out on its transport
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
    const status = await dom.listen();
    dom.serve().handleRequest(resolve.owner, () => new Promise(() => undefined));
    const transport = await frame.getTransport();
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

  it('As the host, I lose a ready frame and it is counted once as lost and captured', async () => {
    // Given a ready frame, and a reporting pipeline that records captures and counts
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
    const status = await dom.bringUp();

    // When its light client dies
    status.fail(new ProtocolFatalError('boom'));
    await advance();

    // Then
    expect(metrics.counted(S.PROTOCOL_FRAME_LOST)).toEqual([{ outcome: 'error', reason: 'ProtocolFatalError' }]);
    expect(metrics.counted(S.PROTOCOL_IFRAME_READY).filter(tags => tags?.['outcome'] === 'error')).toEqual([]);
    expect(captured).toEqual([{ flow: 'protocol', step: 'frame_lost' }]);
  });

  it('As the host, I see ready frames that keep dying each counted, captured once, and captured again after a stable one', async () => {
    // Given a ready frame, and a reporting pipeline that records captures and counts
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
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

  it('As the host, I hear a worker port release end the frame through the typed released interrupt, without a capture', async () => {
    // Given a ready frame, and a reporting pipeline that records captures, counts and breadcrumbs
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const events = recordLog({ onFinished: onTestFinished, level: 'info' });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
    const status = await dom.bringUp();
    const transport = await frame.getTransport();
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
    expect(frame.status.get()).toBe('failed');
  });

  it('As the host, I lose a frame that ends its status cleanly as one that stopped reporting it', async () => {
    // Given a ready frame, with a request out on its transport
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
    const status = await dom.bringUp();
    const transport = await frame.getTransport();
    dom.serve().handleRequest(resolve.owner, () => new Promise(() => undefined));
    const owner = transport.request(resolve.owner, { label: 'doom' }).then(() => null, toError);
    await advance();

    // When the frame ends its status with no failure
    status.interrupt(ok());
    await advance();

    // Then
    expect((await owner)?.message).toBe(PROTOCOL_ERRORS.FRAME_STATUS_ENDED);
    expect(metrics.counted(S.PROTOCOL_FRAME_LOST)).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(frame.status.get()).toBe('failed');
  });

  it('As the host, I receive a late message from a dropped frame and it settles nothing on the new one', async () => {
    // Given a read the first frame holds while it is dropped
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
    const first = dom.getIframe();
    const held = createDeferred<string | null>();
    dom.serve(first).handleRequest(storage.authRead, () => held.promise.then(value => ok(value)));
    const firstStatus = await dom.bringUp();
    const firstTransport = await frame.getTransport();
    // Enough reads that their ids reach past the one the rebuilt frame's read gets
    const oldReads = Array.from({ length: 16 }, () =>
      firstTransport.request(storage.authRead, { siteId: SITE_ID, key: 'k' }).then(() => null, toError),
    );
    await advance();
    firstStatus.fail(new ProtocolFatalError('boom'));
    await advance();

    // And a read on the rebuilt frame, which it never answers
    const rebuilt = await frame.getTransport();
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
    expect(frame.status.get()).toBe('ready');
  });

  it('As the host, I meet a version mismatch and it is final', async () => {
    // Given a frame of another release, which refuses the host wire version
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    const up = catchRejection(frame.waitUntilReady());
    await advance();

    // When
    dom.serveNewer();
    await dom.retryHandshake();
    const failure = await up;
    await advance(60_000);
    const framesAfterBackoff = dom.countFrames();
    frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await advance(60_000);

    // Then
    expect(failure).toBeInstanceOf(ProtocolVersionMismatchError);
    expect(frame.status.get()).toBe('failed');
    expect(framesAfterBackoff).toBe(0);
    expect(dom.countFrames()).toBe(0);
    await expect(frame.waitUntilReady()).rejects.toBeInstanceOf(ProtocolVersionMismatchError);
    await expect(frame.getTransport()).rejects.toBeInstanceOf(ProtocolVersionMismatchError);
    expect(dom.countFrames()).toBe(0);
    expect(metrics.counted(S.PROTOCOL_IFRAME_READY)).toEqual([
      { outcome: 'error', phase: 'listen', reason: 'ProtocolVersionMismatchError' },
    ]);
  });

  it('As the host with an app open, I hear once that a frame rebuilt from a newer release refuses my wire, also when I ask late', async () => {
    // Given a ready frame, and a listener for a mismatch
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
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
    expect(frame.status.get()).toBe('failed');
    expect(dom.countFrames()).toBe(0);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeInstanceOf(ProtocolVersionMismatchError);
    expect(late).toEqual(heard);
  });

  it('As the host, I boot a frame that never answers my handshake and the boot fails and rebuilds with backoff', async () => {
    // Given a frame of an earlier release, which loads and never answers
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    const up = catchRejection(frame.waitUntilReady());
    const silent = dom.getIframe();

    // When
    await advance(HANDSHAKE_TIMEOUT_MS);
    const failure = await up;
    await advance(1_999);
    const framesBeforeBackoff = dom.countFrames();
    await advance(1);

    // Then
    expect(failure).toBeInstanceOf(ProtocolHandshakeTimeoutError);
    expect(silent.isConnected).toBe(false);
    expect(metrics.counted(S.PROTOCOL_IFRAME_READY)).toEqual([
      { outcome: 'error', phase: 'listen', reason: 'ProtocolHandshakeTimeoutError' },
    ]);
    expect(framesBeforeBackoff).toBe(0);
    expect(dom.countFrames()).toBe(1);
  });

  it('As a dotli integrator, I lose a frame that fails the moment it is mounted and it leaves no load timer behind', async () => {
    // Given a page where the frame fails as it is mounted
    const dom = createFrameDom({ mount: 'error', timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);

    // When
    const up = readOutcome(waitForListening(frame));
    await advance();

    // Then the wait fails, and only the rebuild's wait is pending
    expect(await up).toContain(PROTOCOL_ERRORS.HOST_FRAME_LOAD_FAILED);
    expect(frame.status.get()).toBe('failed');
    expect(timers.countPending()).toBe(1);
  });

  /** A configured frame that came up ready and then died with a fatal, so its keeper waits to rebuild it. */
  async function bringFrameDownWithFatal(): Promise<{
    dom: FrameDom;
    frame: ReturnType<typeof createProtocolFrame>;
  }> {
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    const up = frame.waitUntilReady();
    const status = await dom.bringUp();
    await up;
    status.fail(new ProtocolFatalError('boom'));
    await advance();
    return { dom, frame };
  }

  it('As a product, I ask for the chain while the frame waits to rebuild after a fatal, and a new frame boots at once and answers', async () => {
    // Given
    const { dom, frame } = await bringFrameDownWithFatal();
    const framesWhileDown = dom.countFrames();

    // When
    const up = readOutcome(frame.waitUntilReady());
    const framesAfterAsking = dom.countFrames();
    await dom.bringUp();

    // Then
    expect(framesWhileDown).toBe(0);
    expect(framesAfterAsking).toBe(1);
    expect(await up).toBe('resolved');
    expect(frame.status.get()).toBe('ready');
  });

  it('As a product, I ask while the frame is down and the boot I started fails, and I hear that boot failure', async () => {
    // Given
    const { dom, frame } = await bringFrameDownWithFatal();

    // When
    const up = readOutcome(frame.waitUntilReady());
    const status = await dom.listen();
    status.fail(new ProtocolInitFailedError('no SharedWorker'));

    // Then
    expect(await up).toBe('no SharedWorker');
  });

  it('As a host with no caller waiting, I lose the frame and it rebuilds on its own after the backoff', async () => {
    // Given
    const { dom } = await bringFrameDownWithFatal();

    // When
    await advance(1_999);
    const framesBeforeBackoff = dom.countFrames();
    await advance(1);

    // Then
    expect(framesBeforeBackoff).toBe(0);
    expect(dom.countFrames()).toBe(1);
  });

  it('As one of two products asking while the frame is down, I hear the failure of the one boot we share, and one rebuild follows after the backoff', async () => {
    // Given
    const dom = createFrameDom({ timers });
    let builds = 0;
    const frame = createProtocolFrame({
      ...dom.params,
      document: {
        createElement: tagName => {
          builds += 1;
          return dom.params.document.createElement(tagName);
        },
        body: dom.params.document.body,
      },
    });
    frame.configure(FRAME_CONFIG);
    const up = frame.waitUntilReady();
    const firstStatus = await dom.bringUp();
    await up;
    firstStatus.fail(new ProtocolFatalError('boom'));
    await advance();
    const buildsBeforeAsking = builds;

    // When
    const first = readOutcome(frame.waitUntilReady());
    const second = readOutcome(waitForListening(frame));
    const framesAfterAsking = dom.countFrames();
    const status = await dom.listen();
    const secondSettled = await second;
    status.fail(new ProtocolInitFailedError('no SharedWorker'));
    const outcomes = [await first, secondSettled];
    const buildsForUs = builds - buildsBeforeAsking;
    await advance(1_999);
    const framesBeforeBackoff = dom.countFrames();
    await advance(1);

    // Then
    expect(outcomes).toEqual(['no SharedWorker', 'resolved']);
    expect(framesAfterAsking).toBe(1);
    expect(buildsForUs).toBe(1);
    expect(framesBeforeBackoff).toBe(0);
    expect(dom.countFrames()).toBe(1);
    expect(builds - buildsBeforeAsking).toBe(2);
  });

  it('As one of two products asking while the frame is down, I share one rebuild with the other', async () => {
    // Given
    const { dom, frame } = await bringFrameDownWithFatal();

    // When
    const first = readOutcome(frame.waitUntilReady());
    const second = readOutcome(waitForListening(frame));
    const rebuilt = dom.getIframe();
    const framesAfterAsking = dom.countFrames();
    await dom.bringUp();
    await advance(2_000);

    // Then
    expect(framesAfterAsking).toBe(1);
    expect(await first).toBe('resolved');
    expect(await second).toBe('resolved');
    expect(dom.countFrames()).toBe(1);
    expect(dom.getIframe()).toBe(rebuilt);
  });
});

describe('frame liveness check', () => {
  /** A configured frame that came up ready, with the transport the host got for it. */
  async function bringFrameUp(): Promise<{
    dom: FrameDom;
    frame: ReturnType<typeof createProtocolFrame>;
    transport: ProtocolTransport;
  }> {
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    const up = frame.waitUntilReady();
    await dom.bringUp();
    return { dom, frame, transport: await up };
  }

  /** How many heartbeats the host sent `iframe` (the current one by default). */
  function countHeartbeats(dom: FrameDom, iframe = dom.getIframe()): number {
    return dom.readSent(iframe).filter(message => message.tag === 'request' && message.method === 'heartbeat').length;
  }

  it('As a returning user whose ready frame stopped answering, I see it dropped after one check and rebuilt', async () => {
    // Given a ready frame whose app takes the heartbeat and never answers it
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { dom, frame, transport } = await bringFrameUp();
    dom.serve().handleRequest(heartbeat, () => new Promise(() => undefined));
    const stale = dom.getIframe();

    // When
    frame.checkAlive(transport);
    await advance(HANDSHAKE_TIMEOUT_MS);
    const statusAfterCheck = frame.status.get();
    const framesAfterCheck = dom.countFrames();
    await advance(DEFAULT_FRAME_TIMEOUTS.rebuildMs);
    await dom.bringUp();

    // Then
    expect(countHeartbeats(dom, stale)).toBe(1);
    expect(statusAfterCheck).toBe('failed');
    expect(framesAfterCheck).toBe(0);
    expect(dom.getIframe()).not.toBe(stale);
    expect(frame.status.get()).toBe('ready');
    expect(metrics.counted(S.PROTOCOL_FRAME_LOST)).toEqual([
      { outcome: 'error', reason: 'ProtocolFrameUnresponsiveError' },
    ]);
  });

  it('As a returning user whose frame answers the check, I keep it', async () => {
    // Given a ready frame whose app answers the heartbeat
    const { dom, frame, transport } = await bringFrameUp();
    dom.serve().handleRequest(heartbeat, () => Promise.resolve(ok()));
    const kept = dom.getIframe();

    // When
    frame.checkAlive(transport);
    await advance(HANDSHAKE_TIMEOUT_MS);

    // Then
    expect(countHeartbeats(dom)).toBe(1);
    expect(frame.status.get()).toBe('ready');
    expect(dom.getIframe()).toBe(kept);
  });

  it('As a returning user whose frame is from an earlier release, I keep it although it refuses the check', async () => {
    // Given a ready frame whose app does not serve the heartbeat
    const { dom, frame, transport } = await bringFrameUp();
    const kept = dom.getIframe();

    // When
    frame.checkAlive(transport);
    await advance(HANDSHAKE_TIMEOUT_MS);

    // Then
    expect(countHeartbeats(dom)).toBe(1);
    expect(frame.status.get()).toBe('ready');
    expect(dom.getIframe()).toBe(kept);
  });

  it('As a dotli integrator, I check one frame twice before the first check settles and it is asked once', async () => {
    // Given a ready frame whose app answers the heartbeat
    const { dom, frame, transport } = await bringFrameUp();
    dom.serve().handleRequest(heartbeat, () => Promise.resolve(ok()));

    // When
    frame.checkAlive(transport);
    frame.checkAlive(transport);
    await advance(HANDSHAKE_TIMEOUT_MS);

    // Then
    expect(countHeartbeats(dom)).toBe(1);
    expect(frame.status.get()).toBe('ready');
  });

  it('As a dotli integrator, I check a transport of a frame already dropped and nothing happens', async () => {
    // Given a frame dropped by a config change, and the ready frame built in its place
    const { dom, frame, transport: dropped } = await bringFrameUp();
    const stale = dom.getIframe();
    frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await dom.bringUp();
    const current = dom.getIframe();

    // When
    frame.checkAlive(dropped);
    await advance(HANDSHAKE_TIMEOUT_MS);

    // Then
    expect(countHeartbeats(dom, stale)).toBe(0);
    expect(countHeartbeats(dom, current)).toBe(0);
    expect(frame.status.get()).toBe('ready');
    expect(dom.getIframe()).toBe(current);
  });
});

describe('protocol status', () => {
  let host: FrameHost;

  beforeEach(() => {
    host = createFrameHost({ config: FRAME_CONFIG, timers });
  });

  function trackOutcome(promise: Promise<unknown>): { outcome: string | null } {
    const result: { outcome: string | null } = { outcome: null };
    promise.then(
      () => {
        result.outcome = 'resolved';
      },
      (error: unknown) => {
        result.outcome = error instanceof Error ? error.message : String(error);
      },
    );
    return result;
  }

  it('As a dotli integrator, I follow the protocol status from idle to ready, and subscribing starts no frame', async () => {
    // Given
    const statuses: ProtocolStatus[] = [];
    host.client.frame.status.listen(status => statuses.push(status));
    await advance();
    const framesBeforeAsking = host.countFrames();

    // When
    void host.client.frame.ensureReady();
    await host.bringUp();

    // Then
    expect(framesBeforeAsking).toBe(0);
    expect(statuses).toEqual(['booting', 'listening', 'ready']);
    expect(host.client.frame.status.get()).toBe('ready');
  });

  it('As a dotli user whose protocol frame fails its init, I see it reported failed and then rebuilt', async () => {
    // Given
    void host.client.frame.ensureReady().catch(() => undefined);
    const status = await host.listen();
    const dead = host.getIframe();

    // When
    status.fail(new ProtocolInitFailedError('no SharedWorker'));
    await advance();
    const statusAfterFailure = host.client.frame.status.get();
    await advance(2_000);
    await host.bringUp();

    // Then
    expect(statusAfterFailure).toBe('failed');
    expect(dead.isConnected).toBe(false);
    expect(host.getIframe()).not.toBe(dead);
    expect(host.client.frame.status.get()).toBe('ready');
  });

  it('As a dotli user, I make a request while the protocol frame boots and it waits, then fails as soon as that boot fails', async () => {
    // Given
    const warmup = trackOutcome(host.client.resolve.warmup());
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
    host.client.sharedStore.status.listen(status => statuses.push(status));
    const warmup = trackOutcome(host.client.resolve.warmup());
    await host.listen();
    const dead = host.getIframe();

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
    void host.client.frame.ensureReady();
    let status = await host.bringUp();
    const rebuildsAfter: number[] = [];
    const framesAfterRebuild: number[] = [];

    // When each rebuild comes up and dies at once too
    for (let rebuild = 0; rebuild < 3; rebuild++) {
      status.fail(new ProtocolFatalError('boom'));
      await advance();
      let waited = 0;
      while (host.countFrames() === 0 && waited < 60_000) {
        await advance(1_000);
        waited += 1_000;
      }
      framesAfterRebuild.push(host.countFrames());
      rebuildsAfter.push(waited);
      status = await host.bringUp();
    }

    // Then
    expect(framesAfterRebuild).toEqual([1, 1, 1]);
    expect(rebuildsAfter).toEqual([2_000, 4_000, 8_000]);
  });

  it('As a dotli user whose protocol frame stayed up past 30 s, I get its rebuild after 2 s again', async () => {
    // Given two quick deaths grew the wait, then a frame stayed up 30 s
    void host.client.frame.ensureReady();
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
    const framesBeforeWait = host.countFrames();
    await advance(1);

    // Then
    expect(framesBeforeWait).toBe(0);
    expect(host.countFrames()).toBe(1);
  });

  it('As a returning user, I change the frame config during my session and see the shared store down, then available', async () => {
    // Given
    void host.client.frame.ensureReady();
    await host.bringUp();
    const statuses: SharedStoreStatus[] = [];
    host.client.sharedStore.status.listen(status => statuses.push(status));

    // When
    host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await host.listen();

    // Then
    expect(statuses).toEqual(['unavailable', 'available']);
  });

  it('As a dotli integrator, I change the frame config and the chain connections of the dropped frame halt', async () => {
    // Given a chain connection the frame accepted
    const provider = host.client.chains.createProvider(getActiveServicesConfig().people.genesis);
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
    host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });

    // Then
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledWith('frame');
  });

  it('As a dotli user, I change the frame config and a late fatal from the dropped frame does not fail the rebuild', async () => {
    // Given the dropped frame's fatal is sent while the client has no frame
    void host.client.frame.ensureReady();
    const deadStatus = await host.bringUp();
    host.client.frame.status.listen(next => {
      if (next === 'idle') {
        deadStatus.fail(new ProtocolFatalError('late'));
      }
    });

    // When
    host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const read = trackOutcome(host.client.sharedAuth.read(SITE_ID, SHARED_CORE_SESSION_KEY));
    host.serve().handleRequest(storage.authRead, () => new Promise(() => undefined));
    await host.listen();

    // Then
    expect(host.client.frame.status.get()).toBe('listening');
    expect(read.outcome).toBeNull();
    expect(host.readSent().map(message => `${message.tag}:${message.section}.${message.method}`)).toEqual([
      'start:frame.status',
      'start:frame.telemetry',
      'request:storage.authRead',
    ]);
  });

  it('As a dotli integrator, I request from a status listener after a config change, and a later listener hears the status there is on its turn, and a later ready waiter waits on the rebuilt frame', async () => {
    // Given a boot request queued ahead of the rebuilding listener, a second listener, and a ready waiter after both
    const booting = catchRejection(host.client.frame.ensureReady());
    await host.listen();
    const heard: ProtocolStatus[][] = [[], []];
    let request: Promise<void> | null = null;
    host.client.frame.status.listen(next => {
      heard[0]?.push(next);
      if (next === 'idle' && request === null) {
        request = host.client.frame.ensureReady();
      }
    });
    host.client.frame.status.listen(next => heard[1]?.push(next));
    const later = host.client.frame.ensureReady();

    // When
    host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const framesAfterChange = host.countFrames();
    await host.bringUp();

    // Then
    expect(framesAfterChange).toBe(1);
    expect(heard[0]).toEqual(['idle', 'booting', 'listening', 'ready']);
    expect(heard[1]).toEqual(['booting', 'booting', 'listening', 'ready']);
    await expect(request).resolves.toBeUndefined();
    expect((await booting).message).toBe(PROTOCOL_ERRORS.FRAME_RESET);
    await expect(later).resolves.toBeUndefined();
  });

  it('As a dotli integrator, I request from an idle listener during a config change and the frame keeps one keeper', async () => {
    // Given a second keeper would wait behind the first and rebuild the next lost frame at once
    void host.client.frame.ensureReady();
    await host.bringUp();
    host.client.frame.status.listen(next => {
      if (next === 'idle') {
        void host.client.frame.ensureReady().catch(() => undefined);
      }
    });
    host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const status = await host.bringUp();

    // When
    status.fail(new ProtocolFatalError('boom'));
    await advance(1_999);
    const framesBeforeWait = host.countFrames();
    await advance(1);

    // Then
    expect(framesBeforeWait).toBe(0);
    expect(host.countFrames()).toBe(1);
  });

  it('As a dotli user whose frame cannot be built, I see the real error on each request, each request that finds it down builds one, and one keeper retries', async () => {
    // Given
    let builds = 0;
    const dom = createFrameDom({ timers });
    const failing = createProtocolClient({
      ...dom.params,
      document: {
        createElement: () => {
          builds += 1;
          throw new Error('no iframe here');
        },
        body: dom.params.document.body,
      },
    });
    failing.frame.configure(FRAME_CONFIG);

    // When the first build fails in the turn it is asked for, so the second request finds the frame down and boots
    // its own
    const first = trackOutcome(failing.frame.ensureReady());
    const second = trackOutcome(failing.frame.ensureReady());
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
      const dom = createFrameDom({ timers });
      const failing = createProtocolClient({
        ...dom.params,
        document: {
          createElement: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- a thrown non-Error is the case under test
            throw thrown;
          },
          body: dom.params.document.body,
        },
      });
      failing.frame.configure(FRAME_CONFIG);

      // When the first build fails
      void trackOutcome(failing.frame.ensureReady());
      await advance();

      // Then the failure is counted with the reason of the thrown value
      expect(metrics.counted(S.PROTOCOL_IFRAME_READY)).toContainEqual({ outcome: 'error', phase: 'load', reason });
    },
  );

  it('As a dotli user, I change the config during the wait before a rebuild and get a frame at once, and the dropped wait leaves no second rebuild', async () => {
    // Given a retry left over from the dropped wait would rebuild the next lost frame at once
    void host.client.frame.ensureReady();
    let status = await host.bringUp();
    status.fail(new ProtocolFatalError('boom'));
    await advance(1_000);

    // When
    host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const mode = new URL(host.getIframe().src).searchParams.get('mode');
    status = await host.bringUp();
    status.fail(new ProtocolFatalError('boom'));
    await advance(1_999);
    const framesBeforeWait = host.countFrames();
    await advance(1);

    // Then
    expect(mode).toBe('rpc');
    expect(framesBeforeWait).toBe(0);
    expect(host.countFrames()).toBe(1);
  });

  it('As a dotli integrator, I change the config and request from a failed listener and the request resolves', async () => {
    // Given
    void host.client.frame.ensureReady();
    const status = await host.bringUp();
    let request: Promise<void> | null = null;
    host.client.frame.status.listen(next => {
      if (next === 'failed' && request === null) {
        host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
        request = host.client.frame.ensureReady();
      }
    });

    // When
    status.fail(new ProtocolFatalError('boom'));
    await advance();
    await host.bringUp();

    // Then
    await expect(request).resolves.toBeUndefined();
    expect(host.client.frame.status.get()).toBe('ready');
  });

  it('As a dotli integrator, I change the config from a booting listener and one frame is kept, built with the new config', async () => {
    // Given
    let changes = 0;
    host.client.frame.status.listen(next => {
      if (next === 'booting' && changes === 0) {
        changes += 1;
        host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
      }
    });

    // When
    void host.client.frame.ensureReady().catch(() => undefined);
    const framesAfterChange = host.countFrames();
    const mode = new URL(host.getIframe().src).searchParams.get('mode');
    void host.client.frame.ensureReady();
    await host.bringUp();

    // Then
    expect(framesAfterChange).toBe(1);
    expect(mode).toBe('rpc');
    expect(host.client.frame.status.get()).toBe('ready');
  });

  it('As a dotli integrator, I unsubscribe a listener from another listener and it hears nothing after that, not even the change of that round', async () => {
    // Given
    void host.client.frame.ensureReady();
    const status = await host.bringUp();
    const heard: ProtocolStatus[] = [];
    let unsubscribe: (() => void) | null = null;
    host.client.frame.status.listen(next => {
      if (next === 'failed') {
        host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
        unsubscribe?.();
      }
    });
    unsubscribe = host.client.frame.status.listen(next => heard.push(next));

    // When
    status.fail(new ProtocolFatalError('boom'));
    await advance();

    // Then the change it was due to hear when it was unsubscribed is dropped too
    expect(heard).toEqual([]);
  });
});
