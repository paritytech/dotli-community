// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { getActiveServicesConfig, SITE_ID } from '@dotli/config';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import { createDeferred, toError } from '@dotli/shared';
import { catchRejection, createManualTimers, readOutcome, recordLog, type ManualTimers } from '@dotli/shared/testing';
import { createTransport, createWindowProvider, domain, err, ok, type Sink } from '@dotli/transport';
import { recordMessage } from '@dotli/transport/testing';
import type { RemoteChainHalt } from '@dotli/chains';
import { createProtocolClient } from './createProtocolClient.js';
import { createFrameStatus, type FrameStatus } from './createFrameStatus.js';
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
import type { ProtocolFrame, ProtocolFrameParams, ProtocolFrameTimeouts, ProtocolStatus } from './frameTypes.js';
import { protocolSchema, type ProtocolTransport, type SharedAuthChange, type SubscriptionEnd } from './schema.js';
import { SHARED_CORE_SESSION_KEY } from './sharedAuthKeys.js';
import { FRAME_CONFIG, HOST_ORIGIN } from './testing/constants.js';
import { createFrameDom, type FrameDom } from './testing/createFrameDom.js';
import type { FakeIframe } from './testing/fakeIframe.js';
import { createFrameHost, type FrameHost } from './testing/createFrameHost.js';

const { resolve, storage, chain } = protocolSchema.sections;
const { heartbeat } = protocolSchema.sections.frame;

type ChangeSink = Sink<SharedAuthChange, SubscriptionEnd<undefined>>;

const HANDSHAKE_TIMEOUT_MS = DEFAULT_FRAME_TIMEOUTS.handshakeMs;
/** What the frame reports when a status listener throws. */
const STATUS_LISTENER_CAPTURE = { step: 'listener', tags: { owner: 'protocol.status' } };
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

/** `dom`'s params, which keep the iframe the frame built last, so a test answers a frame booted beside a held one. */
function recordIframes(dom: FrameDom): { params: ProtocolFrameParams<FakeIframe>; getNewest: () => FakeIframe } {
  let newest: FakeIframe | null = null;
  return {
    params: {
      ...dom.params,
      document: {
        createElement: tagName => {
          newest = dom.params.document.createElement(tagName);
          return newest;
        },
        body: dom.params.document.body,
      },
    },
    getNewest: () => {
      if (newest === null) {
        throw new Error('no protocol iframe built');
      }
      return newest;
    },
  };
}

/**
 * Answers `iframe` as a frame app that relays sibling tabs' auth changes, keeping each subscriber's sink while it is
 * subscribed. The served frame of `createFrameDom` keeps none.
 */
function serveRelayingFrame(iframe: FakeIframe): { status: FrameStatus; sinks: Set<ChangeSink> } {
  const window = iframe.window;
  const serving = createTransport({
    schema: protocolSchema,
    provider: createWindowProvider({ listen: window, peer: () => window.parent, origin: HOST_ORIGIN }),
    handshake: 'respond',
    hello: { resolutionId: null },
  });
  const status = createFrameStatus();
  serving.handleSubscription(protocolSchema.sections.frame.status, status.handler);
  const sinks = new Set<ChangeSink>();
  serving.handleSubscription(storage.authChanges, (_start, _context, sink) => {
    sinks.add(sink);
    return () => {
      sinks.delete(sink);
    };
  });
  return { status, sinks };
}

/** A configured frame whose light client failed to start, held for the shared store, with the iframe it holds. */
async function holdFailedFrame(timeouts: Partial<ProtocolFrameTimeouts> = {}): Promise<{
  dom: FrameDom;
  iframes: ReturnType<typeof recordIframes>;
  frame: ProtocolFrame;
  held: FakeIframe;
}> {
  const dom = createFrameDom({ timers, timeouts });
  const iframes = recordIframes(dom);
  const frame = createProtocolFrame(iframes.params);
  frame.configure(FRAME_CONFIG);
  void frame.waitUntilReady().catch(() => undefined);
  const status = await dom.listen();
  status.fail(new ProtocolInitFailedError('no SharedWorker'));
  await advance();
  return { dom, iframes, frame, held: dom.getIframe() };
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
    expect(metrics.counted('protocol.wire_refused')).toEqual([
      { outcome: 'refused', reason: 'malformed', side: 'host' },
      { outcome: 'refused', reason: 'not_bytes', side: 'host' },
    ]);
    expect(
      events
        .filter(line => line.message === 'protocol message refused')
        .map(({ message, attrs }) => ({ message, attrs })),
    ).toMatchObject([
      {
        message: 'protocol message refused',
        // An asymmetric matcher is typed any.
        attrs: { reason: 'malformed', side: 'host', cause: expect.any(String) as string },
      },
      { message: 'protocol message refused', attrs: { reason: 'not_bytes', side: 'host' } },
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
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
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

    // When the frame refuses the host wire version, and the longest rebuild waits pass
    dom.serveNewer();
    await dom.retryHandshake();
    await advance(DEFAULT_FRAME_TIMEOUTS.maxRebuildMs * 3);

    // Then the mismatch was heard and stayed final, and the listener's throw was reported once
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeInstanceOf(ProtocolVersionMismatchError);
    expect(statuses).toEqual(['failed']);
    expect(frame.status.get()).toBe('failed');
    expect(dom.countFrames()).toBe(0);
    expect(captured).toMatchObject([STATUS_LISTENER_CAPTURE]);
    expect(metrics.counted('listener.delivery')).toEqual([STATUS_LISTENER_REPORT]);
  });

  it('As the host, I boot a frame while a status listener throws on booting, and the throw is reported and the boot goes on', async () => {
    // Given a configured frame, and a status listener that throws on booting
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
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
    expect(metrics.counted('protocol.iframe_ready')).toEqual([]);
    expect(captured).toMatchObject([STATUS_LISTENER_CAPTURE]);
    expect(metrics.counted('listener.delivery')).toEqual([STATUS_LISTENER_REPORT]);
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

  it('As the host, I wait for the frame and its light client fails to start, and my wait rejects with that failure', async () => {
    // Given a ready waiter on a listening frame
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    const up = catchRejection(frame.waitUntilReady());
    const status = await dom.listen();

    // When
    status.fail(new ProtocolInitFailedError('no SharedWorker'));
    const failure = await up;

    // Then
    expect(failure).toBeInstanceOf(ProtocolInitFailedError);
    expect(failure.message).toBe('no SharedWorker');
    expect(frame.storeHeld.get()).toBe(true);
  });

  it('As a returning user, I change the frame config while the store is held and the held frame goes', async () => {
    // Given
    const { frame, held } = await holdFailedFrame();

    // When
    frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });

    // Then
    expect(frame.storeHeld.get()).toBe(false);
    expect(held.isConnected).toBe(false);
  });

  it('As the host, I drop a frame while a status listener throws, and the change returns, the throw is reported and the frame is still cleaned up', async () => {
    // Given a listening frame, and a status listener that throws when the frame goes idle
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
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
    expect(captured).toMatchObject([STATUS_LISTENER_CAPTURE]);
    expect(metrics.counted('listener.delivery')).toEqual([STATUS_LISTENER_REPORT]);
  });

  it('As the host, I let a frame listen while a status listener throws on it, and the throw is reported and the frame stays up', async () => {
    // Given a booting frame, its transport, and a status listener that throws when the frame listens
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
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
    expect(captured).toMatchObject([STATUS_LISTENER_CAPTURE]);
    expect(metrics.counted('listener.delivery')).toEqual([STATUS_LISTENER_REPORT]);
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
    expect(metrics.counted('protocol.iframe_ready')).toEqual([
      { outcome: 'error', phase: 'ready', reason: 'ProtocolFatalError' },
    ]);
  });

  it('As the host, I lose a ready frame and it is counted once as lost and captured', async () => {
    // Given a ready frame, and a reporting pipeline that records captures and counts
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
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
    expect(metrics.counted('protocol.frame_lost')).toEqual([{ outcome: 'error', reason: 'ProtocolFatalError' }]);
    expect(metrics.counted('protocol.iframe_ready').filter(tags => tags?.['outcome'] === 'error')).toEqual([]);
    expect(captured).toMatchObject([{ step: 'frame_lost' }]);
  });

  it('As the host, I see ready frames that keep dying each counted, captured once, and captured again after a stable one', async () => {
    // Given a ready frame, and a reporting pipeline that records captures and counts
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
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
    expect(metrics.counted('protocol.frame_lost')).toHaveLength(2);
    expect(captured).toMatchObject([{ step: 'frame_lost' }]);

    // When the next frame stays ready for the stable span before it dies
    const third = await dom.bringUp();
    await advance(30_000);
    third.fail(new ProtocolFatalError('boom'));
    await advance();

    // Then its loss is counted and captured again
    expect(metrics.counted('protocol.frame_lost')).toHaveLength(3);
    expect(captured).toMatchObject([{ step: 'frame_lost' }, { step: 'frame_lost' }]);
  });

  it('As the host, I see a frame that stayed up and then keeps dying rebuilt after twice the first wait, not the first wait again', async () => {
    // Given a frame that stayed ready for the stable span, died, and was rebuilt after the first wait
    const dom = createFrameDom({ timers });
    const iframes = recordIframes(dom);
    const frame = createProtocolFrame(iframes.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
    const first = await dom.bringUp();
    await advance(DEFAULT_FRAME_TIMEOUTS.stableMs);
    first.fail(new ProtocolFatalError('boom'));
    await advance(DEFAULT_FRAME_TIMEOUTS.rebuildMs);
    const second = await dom.bringUp();
    const rebuilt = iframes.getNewest();

    // When the rebuilt frame dies soon after ready
    second.fail(new ProtocolFatalError('boom'));
    await advance(DEFAULT_FRAME_TIMEOUTS.rebuildMs);
    const builtAfterFirstWait = iframes.getNewest() !== rebuilt;
    await advance(DEFAULT_FRAME_TIMEOUTS.rebuildMs);

    // Then
    expect([builtAfterFirstWait, iframes.getNewest() !== rebuilt]).toEqual([false, true]);
  });

  it('As the host, I see a frame that dies soon after ready captured when the frame before it stayed up and was reconfigured away', async () => {
    // Given a frame that died soon after ready, and the rebuilt frame that stayed ready for the stable span
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
    const first = await dom.bringUp();
    await advance(1_000);
    first.fail(new ProtocolFatalError('boom'));
    await advance(2_000);
    await dom.bringUp();
    await advance(30_000);
    frame.configure({ ...FRAME_CONFIG, network: 'previewnet' });
    const third = await dom.bringUp();
    await advance(1_000);

    // When the frame booted on the new config dies soon after ready
    third.fail(new ProtocolFatalError('boom'));
    await advance();

    // Then both quick losses are counted and captured, and the reconfigured one is neither
    expect(metrics.counted('protocol.frame_lost')).toHaveLength(2);
    expect(captured).toMatchObject([{ step: 'frame_lost' }, { step: 'frame_lost' }]);
    expect(captured.map(report => report.error)).toEqual([
      expect.any(ProtocolFatalError),
      expect.any(ProtocolFatalError),
    ]);
  });

  it('As the host, I see a frame that dies soon after ready captured when the frame before it stayed up and its port was released', async () => {
    // Given a frame that died soon after ready, the rebuilt frame that stayed ready for the stable span and was released, and the frame rebuilt after it ready
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
    const first = await dom.bringUp();
    await advance(1_000);
    first.fail(new ProtocolFatalError('boom'));
    await advance(2_000);
    const second = await dom.bringUp();
    await advance(30_000);
    second.interrupt(err(domain({ tag: 'released', value: 'The worker released this tab' })));
    await advance(2_000);
    const third = await dom.bringUp();
    await advance(1_000);

    // When the frame rebuilt after the release dies soon after ready
    third.fail(new ProtocolFatalError('boom'));
    await advance();

    // Then all three losses are counted, the release is not captured, and both quick losses are
    expect(metrics.counted('protocol.frame_lost')).toHaveLength(3);
    expect(captured).toMatchObject([{ step: 'frame_lost' }, { step: 'frame_lost' }]);
    expect(captured.map(report => report.error)).toEqual([
      expect.any(ProtocolFatalError),
      expect.any(ProtocolFatalError),
    ]);
  });

  it('As the host, I hear a worker port release end the frame through the typed released interrupt, without a capture', async () => {
    // Given a ready frame, and a reporting pipeline that records captures, counts and breadcrumbs
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
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
    expect(metrics.counted('protocol.frame_lost')).toEqual([{ outcome: 'error', reason: 'ProtocolPortReleasedError' }]);
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
    expect(metrics.counted('protocol.frame_lost')).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(frame.status.get()).toBe('failed');
  });

  it("As the host, I change the config while the frame loads and the dropped load's timer fails nothing", async () => {
    // Given a frame that has been loading for part of its load wait, and a recording metrics pipeline
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ mount: null, timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.getTransport().catch(() => undefined);
    await advance(DEFAULT_FRAME_TIMEOUTS.loadMs / 2);

    // When the config changes, and the dropped frame's load wait comes due while the new frame still loads
    frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const pendingAfterChange = timers.countPending();
    await advance(DEFAULT_FRAME_TIMEOUTS.loadMs / 2);

    // Then only the new frame's load wait was pending, and the new frame still boots
    expect(pendingAfterChange).toBe(1);
    expect(frame.status.get()).toBe('booting');
    expect(metrics.counted('protocol.iframe_ready')).toEqual([]);
  });

  it('As the host, I boot a frame that never loads and the boot fails at load and rebuilds', async () => {
    // Given a frame whose document never loads, and a recording metrics pipeline
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ mount: null, timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    const up = catchRejection(frame.waitUntilReady());

    // When
    await advance(DEFAULT_FRAME_TIMEOUTS.loadMs);

    // Then the wait fails with the load timeout, counted at load, and only the rebuild's wait is pending
    expect((await up).message).toBe(PROTOCOL_ERRORS.HOST_FRAME_LOAD_TIMEOUT);
    expect(metrics.counted('protocol.iframe_ready')).toEqual([{ outcome: 'error', phase: 'load', reason: 'Error' }]);
    expect(frame.status.get()).toBe('failed');
    expect(timers.countPending()).toBe(1);
  });

  it('As a returning user whose phone froze the tab while my frame loaded, I keep the frame when the tab wakes', async () => {
    // Given a frame whose iframe is mounted and not loaded, and a recording metrics pipeline
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ mount: null, timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.getTransport().catch(() => undefined);
    await advance();

    // When the page is frozen, wakes, and the iframe then loads and the frame listens
    timers.freeze(300_000);
    await advance(0);
    dom.getIframe().dispatchEvent(new Event('load'));
    await dom.listen();

    // Then
    expect(metrics.counted('protocol.iframe_ready')).toEqual([]);
    expect(frame.status.get()).toBe('listening');
  });

  it('As a returning user whose phone froze the tab while my frame waited for its light client, I keep the frame when the tab wakes', async () => {
    // Given a frame that listens, and a recording metrics pipeline
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
    const status = await dom.listen();

    // When the page is frozen, wakes, and the frame then reports ready
    timers.freeze(300_000);
    await advance(0);
    status.markReady();
    await advance();

    // Then
    expect(frame.status.get()).toBe('ready');
    expect(metrics.counted('protocol.iframe_ready')).toEqual([]);
  });

  it('As a dotli integrator whose page froze before it configured the frame, my wait still waits when the page wakes', async () => {
    // Given an unconfigured frame and a ready wait
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame(dom.params);
    const outcome = readOutcome(frame.waitUntilReady());
    await advance();

    // When the page is frozen, wakes, and is then configured and the frame comes up
    timers.freeze(300_000);
    await advance(0);
    frame.configure(FRAME_CONFIG);
    await advance();
    await dom.bringUp();

    // Then
    expect(await outcome).toBe('resolved');
  });

  it('As the host, I lose a frame whose mount throws', async () => {
    // Given a page that refuses to mount the frame, and a recording metrics pipeline
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const dom = createFrameDom({ timers });
    const frame = createProtocolFrame({
      ...dom.params,
      document: {
        createElement: tagName => dom.params.document.createElement(tagName),
        body: {
          appendChild: () => {
            throw new Error('mount refused');
          },
        },
      },
    });
    frame.configure(FRAME_CONFIG);

    // When
    const failure = await catchRejection(frame.waitUntilReady());

    // Then the wait fails with the throw, counted at load, and only the rebuild's wait is pending
    expect(failure.message).toBe('mount refused');
    expect(metrics.counted('protocol.iframe_ready')).toEqual([{ outcome: 'error', phase: 'load', reason: 'Error' }]);
    expect(frame.status.get()).toBe('failed');
    expect(timers.countPending()).toBe(1);
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

  it('As the host whose rebuilt frame refuses my wire while my store is held, I see the held frame go and the store no longer held', async () => {
    // Given a held frame, and the frame rebuilt after the backoff from a newer release
    const { dom, iframes, frame, held } = await holdFailedFrame();
    await advance(DEFAULT_FRAME_TIMEOUTS.rebuildMs);
    const rebuilt = iframes.getNewest();

    // When the rebuilt frame refuses the wire, and the host asks for a transport
    dom.serveNewer(rebuilt);
    await dom.retryHandshake();
    const failure = await catchRejection(frame.getTransport());

    // Then
    expect(held.isConnected).toBe(false);
    expect(frame.storeHeld.get()).toBe(false);
    expect(frame.status.get()).toBe('failed');
    expect(failure).toBeInstanceOf(ProtocolVersionMismatchError);
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
    expect(metrics.counted('protocol.iframe_ready')).toEqual([
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
    expect(metrics.counted('protocol.iframe_ready')).toEqual([
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

  /** A configured frame that came up ready and then died with a fatal, so it waits to rebuild. */
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

  it('As a product, I ask for the chain while the store is held and fail at once with the init failure, and no frame boots before the backoff', async () => {
    // Given
    const { dom, frame } = await holdFailedFrame();

    // When
    const failure = await catchRejection(frame.waitUntilReady());
    const framesAfterAsking = dom.countFrames();
    await advance(1_999);
    const framesBeforeBackoff = dom.countFrames();

    // Then
    expect(failure).toBeInstanceOf(ProtocolInitFailedError);
    expect(failure.message).toBe('no SharedWorker');
    expect(framesAfterAsking).toBe(1);
    expect(framesBeforeBackoff).toBe(1);
    expect(frame.status.get()).toBe('failed');
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
    expect(framesBeforeBackoff).toBe(1);
    expect(dom.countFrames()).toBe(2);
    expect(builds - buildsBeforeAsking).toBe(2);
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
    expect(metrics.counted('protocol.frame_lost')).toEqual([
      { outcome: 'error', reason: 'ProtocolFrameUnresponsiveError' },
    ]);
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

  it('As a returning user whose held frame stopped answering, I see it dropped', async () => {
    // Given a held frame whose app takes the heartbeat and never answers it, and a rebuild that waits past the check
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { dom, frame, held } = await holdFailedFrame({ rebuildMs: HANDSHAKE_TIMEOUT_MS * 2 });
    dom.serve(held).handleRequest(heartbeat, () => new Promise(() => undefined));
    const transport = await frame.getTransport();

    // When
    frame.checkAlive(transport);
    await advance(HANDSHAKE_TIMEOUT_MS);

    // Then
    expect(countHeartbeats(dom, held)).toBe(1);
    expect(frame.storeHeld.get()).toBe(false);
    expect(held.isConnected).toBe(false);
    expect(frame.status.get()).toBe('failed');
    expect(metrics.counted('protocol.frame_lost')).toEqual([
      { outcome: 'error', reason: 'ProtocolFrameUnresponsiveError' },
    ]);
  });

  it('As a returning user whose held frame is replaced while it is being checked, I see no frame counted as lost', async () => {
    // Given a held frame whose app takes the heartbeat and never answers it, being checked
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const lines = recordLog({ onFinished: onTestFinished });
    const { dom, iframes, frame, held } = await holdFailedFrame();
    dom.serve(held).handleRequest(heartbeat, () => new Promise(() => undefined));
    frame.checkAlive(await frame.getTransport());
    await advance();

    // When the frame rebuilt after the backoff listens before the check gives up, and its light client fails to start
    await advance(DEFAULT_FRAME_TIMEOUTS.rebuildMs);
    const rebuilt = iframes.getNewest();
    const status = dom.getFrameStatus(rebuilt);
    await dom.retryHandshake();
    status.fail(new ProtocolInitFailedError('no SharedWorker'));
    await advance(HANDSHAKE_TIMEOUT_MS);

    // Then
    expect(held.isConnected).toBe(false);
    expect(rebuilt.isConnected).toBe(true);
    expect(frame.storeHeld.get()).toBe(true);
    expect(metrics.counted('protocol.frame_lost')).toEqual([]);
    expect(lines.filter(line => line.attrs?.['outcome'] === 'lost')).toEqual([]);
  });

  it('As a dotli integrator, I check the rebuilt frame after a config change dropped a frame under check, and the rebuilt frame is asked at once', async () => {
    // Given a ready frame whose app never answers the heartbeat, and a check of it that waits
    const { dom, frame, transport: replaced } = await bringFrameUp();
    dom.serve().handleRequest(heartbeat, () => new Promise(() => undefined));
    frame.checkAlive(replaced);
    await advance();

    // When a config change rebuilds the frame, and the rebuilt frame is checked
    frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const up = frame.waitUntilReady();
    await dom.bringUp();
    const rebuilt = await up;
    dom.serve().handleRequest(heartbeat, () => Promise.resolve(ok()));
    frame.checkAlive(rebuilt);
    await advance();

    // Then the rebuilt frame was asked once
    expect(countHeartbeats(dom)).toBe(1);
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

  it('As a dotli user whose protocol frame fails its init, I keep my shared store until a new frame listens', async () => {
    // Given a listening frame whose app answers a shared store read
    const dom = createFrameDom({ timers });
    const iframes = recordIframes(dom);
    const frame = createProtocolFrame(iframes.params);
    frame.configure(FRAME_CONFIG);
    void frame.waitUntilReady().catch(() => undefined);
    const status = await dom.listen();
    const dead = dom.getIframe();
    dom.serve(dead).handleRequest(storage.authRead, () => Promise.resolve(ok('kept')));

    // When its light client fails to start, the rebuild after the backoff boots, and then listens
    status.fail(new ProtocolInitFailedError('no SharedWorker'));
    await advance();
    const statusAfterFailure = frame.status.get();
    const heldAfterFailure = frame.storeHeld.get();
    const connectedAfterFailure = dead.isConnected;
    const read = await (await frame.getTransport()).request(storage.authRead, { siteId: SITE_ID, key: 'k' });
    await advance(2_000);
    const statusWhileBooting = frame.status.get();
    const heldWhileBooting = frame.storeHeld.get();
    const rebuilt = iframes.getNewest();
    dom.getFrameStatus(rebuilt);
    await dom.retryHandshake();

    // Then
    expect(statusAfterFailure).toBe('failed');
    expect(heldAfterFailure).toBe(true);
    expect(connectedAfterFailure).toBe(true);
    expect(read).toEqual(ok('kept'));
    expect(statusWhileBooting).toBe('booting');
    expect(heldWhileBooting).toBe(true);
    expect(frame.status.get()).toBe('listening');
    expect(dead.isConnected).toBe(false);
    expect(rebuilt.isConnected).toBe(true);
    expect(frame.storeHeld.get()).toBe(false);
  });

  it('As a returning user whose light client keeps failing to start, I never see my shared store down through a rebuild', async () => {
    // Given a client whose shared store I follow before its first frame listens
    const dom = createFrameDom({ timers });
    const iframes = recordIframes(dom);
    const client = createProtocolClient(iframes.params);
    client.frame.configure(FRAME_CONFIG);
    const statuses: SharedStoreStatus[] = [];
    client.sharedStore.status.listen(status => statuses.push(status));
    void client.frame.ensureReady().catch(() => undefined);
    const first = await dom.listen();

    // When its light client fails to start, the rebuild after the backoff listens, and its light client fails too
    first.fail(new ProtocolInitFailedError('no SharedWorker'));
    await advance();
    await advance(2_000);
    const rebuilt = dom.getFrameStatus(iframes.getNewest());
    await dom.retryHandshake();
    rebuilt.fail(new ProtocolInitFailedError('no SharedWorker'));
    await advance();

    // Then
    expect(statuses).toEqual(['available']);
  });

  it("As a user whose light client failed to start, I keep hearing my sibling tabs' auth changes on the frame that replaces the held one", async () => {
    // Given a client whose shared auth I follow, on a frame whose light client failed to start
    const dom = createFrameDom({ timers });
    const iframes = recordIframes(dom);
    const client = createProtocolClient(iframes.params);
    client.frame.configure(FRAME_CONFIG);
    const changes: SharedAuthChange[] = [];
    client.sharedAuth.subscribe(change => changes.push(change));
    const first = await dom.listen();
    first.fail(new ProtocolInitFailedError('no SharedWorker'));
    await advance();
    const held = dom.getIframe();

    // When the rebuild after the backoff listens, and a sibling tab writes through it
    await advance(2_000);
    const rebuilt = serveRelayingFrame(iframes.getNewest());
    await dom.retryHandshake();
    for (const sink of rebuilt.sinks) {
      sink.send({ tag: 'session', value: { siteId: SITE_ID, key: 'k', value: 'v' } });
    }
    await advance();

    // Then
    expect(held.isConnected).toBe(false);
    expect(changes).toEqual([{ tag: 'session', value: { siteId: SITE_ID, key: 'k', value: 'v' } }]);
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

  it('As a dotli integrator, I request from a status listener after a config change, and each listener hears every status in turn, and the waits of the dropped frame fail with the reset', async () => {
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
    const later = catchRejection(host.client.frame.ensureReady());

    // When
    host.client.frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    const framesAfterChange = host.countFrames();
    await host.bringUp();

    // Then
    expect(framesAfterChange).toBe(1);
    expect(heard[0]).toEqual(['idle', 'booting', 'listening', 'ready']);
    expect(heard[1]).toEqual(['idle', 'booting', 'listening', 'ready']);
    await expect(request).resolves.toBeUndefined();
    expect((await booting).message).toBe(PROTOCOL_ERRORS.FRAME_RESET);
    expect((await later).message).toBe(PROTOCOL_ERRORS.FRAME_RESET);
  });

  it('As a dotli integrator, I request from an idle listener during a config change and the lost frame is rebuilt once, after its wait', async () => {
    // Given a frame that would rebuild the next lost frame at once if a second rebuild were waiting
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

  it('As a dotli integrator, I configure again from an idle listener during a config change and one frame is built, with the latest config', async () => {
    // Given a ready frame, and a listener that configures again on its first idle
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
    void frame.waitUntilReady();
    await dom.bringUp();
    let reconfigured = false;
    onTestFinished(
      frame.status.listen(next => {
        if (next === 'idle' && !reconfigured) {
          reconfigured = true;
          frame.configure({ ...FRAME_CONFIG, network: 'previewnet' });
        }
      }),
    );
    const buildsBeforeChange = builds;

    // When
    frame.configure({ ...FRAME_CONFIG, backend: 'rpc-gateway' });
    await advance();

    // Then
    const params = new URL(dom.getIframe().src).searchParams;
    expect(builds - buildsBeforeChange).toBe(1);
    expect(params.get('mode')).toBe('direct');
    expect(params.get('network')).toBe('previewnet');
  });

  it('As a dotli user whose frame cannot be built, I see the real error on each request, each request that finds it down builds one, and one frame is retried', async () => {
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
      expect(metrics.counted('protocol.iframe_ready')).toContainEqual({ outcome: 'error', phase: 'load', reason });
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
});
