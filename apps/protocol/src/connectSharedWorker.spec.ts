// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The worker is a transport on the far end of a real port pair, so the link speaks to it over the wire.

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import {
  protocolSchema,
  ProtocolFatalError,
  ProtocolInitFailedError,
  createFrameStatus,
  type FrameStatus,
  type FrameStatusEnd,
} from '@dotli/protocol';
import { createDeferred } from '@dotli/shared';
import {
  catchError,
  createFakePage,
  type FakePage,
  createManualTimers,
  type ManualTimers,
} from '@dotli/shared/testing';
import {
  createPortProvider,
  createTransport,
  domain,
  err,
  ok,
  type DomainError,
  type MethodTypes,
  type Sink,
} from '@dotli/transport';
import { connectSharedWorker, type SharedWorkerLink } from './connectSharedWorker.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { createWaitList } from './testing/createWaitList.js';
import { getWorkerEndError, type WorkerEnd } from './watchWorkerStatus.js';

/** A worker on the far end of a real port, with the levers a test pulls. */
type FakeWorker = ReturnType<typeof createFakeWorker>;

type Params = {
  /** The tab's page, whose `pagehide` lets go of the worker. A fresh fake page when unset. */
  page?: FakePage;
  /** The link's timers, which move only when a case advances them. */
  timers?: ManualTimers;
  /** The page load the link tells the worker. */
  resolutionId?: string | null;
};

const { frame } = protocolSchema.sections;

const READY_TIMEOUT_MS = 30_000;

const channels = new Set<MessageChannel>();

afterEach(() => {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  channels.clear();
});

function createFakeWorker() {
  const channel = new MessageChannel();
  channels.add(channel);
  const serving = createTransport({
    schema: protocolSchema,
    provider: createPortProvider({ port: channel.port1 }),
    handshake: 'respond',
    hello: { resolutionId: null },
  });
  const status = createFrameStatus();
  const statusHeard = createDeferred<undefined>();
  serving.handleSubscription(frame.status, (start, context, sink) => {
    statusHeard.resolve(undefined);
    return status.handler(start, context, sink);
  });
  const portClosed = createDeferred<undefined>();
  channel.port1.addEventListener('close', () => {
    portClosed.resolve(undefined);
  });
  const heartbeats: (string | null)[] = [];
  const heartbeatWaits = createWaitList();
  let refusing = false;
  let holding = false;
  const held = createDeferred<undefined>();
  serving.handleRequest(frame.heartbeat, (_payload, context) => {
    heartbeats.push(context.hello.resolutionId);
    heartbeatWaits.check();
    if (refusing) {
      throw new Error('heartbeat refused');
    }
    return holding ? held.promise.then(() => ok()) : ok();
  });
  const beatSinks = new Set<Sink<MethodTypes<typeof frame.beat>['receive'], DomainError<typeof frame.beat>>>();
  const beatsHeard = createDeferred<undefined>();
  serving.handleSubscription(frame.beat, (_start, _context, sink) => {
    beatSinks.add(sink);
    beatsHeard.resolve(undefined);
    return () => {
      beatSinks.delete(sink);
    };
  });
  const workerTarget = new EventTarget();
  const worker = Object.assign(workerTarget, { port: channel.port2 });
  return {
    /** The SharedWorker the link is handed. */
    worker,
    /** The worker's own status, which its serving end reports. */
    status,
    /** The resolution id of each heartbeat the worker heard, in order. */
    heartbeats,
    /** Settles on the next heartbeat the worker hears. Never rejects. */
    waitForHeartbeat,
    /** Settles once the tab subscribed to the worker's beats. */
    beatsHeard: beatsHeard.promise,
    /** The worker's heartbeat clock ticks, so it beats on every open beat subscription. */
    beatTab(): void {
      for (const sink of [...beatSinks]) {
        sink.send(undefined);
      }
    },
    /** Makes each later heartbeat fail on the worker. */
    refuseHeartbeats(): void {
      refusing = true;
    },
    /** Leaves each later heartbeat unanswered until `failHeld`. */
    holdHeartbeats(): void {
      holding = true;
    },
    /** Fails every heartbeat held so far. */
    failHeld(error: Error): void {
      held.reject(error);
    },
    /** Settles once the tab's status subscription reached the worker. */
    statusHeard: statusHeard.promise,
    /** Settles once the tab's end of the worker's port closes, which a closing transport does and tells nothing else. */
    portClosed: portClosed.promise,
    /** The worker's end of the port. */
    serving,
    /** The worker script fails to load. */
    failToStart(message: string): void {
      workerTarget.dispatchEvent(new ErrorEvent('error', { message }));
    },
    /** Makes each later removal of a listener from the worker throw `error`. */
    refuseListenerRemoval(error: Error): void {
      worker.removeEventListener = () => {
        throw error;
      };
    },
  };

  function waitForHeartbeat(): Promise<void> {
    const seen = heartbeats.length;
    return heartbeatWaits.waitFor(() => heartbeats.length > seen);
  }
}

/** Links a tab to `fake` with the ready wait every case uses. */
function link(
  fake: FakeWorker,
  { page = createFakePage(), timers = createManualTimers(), resolutionId = null }: Params = {},
): SharedWorkerLink {
  return connectSharedWorker({
    worker: fake.worker,
    page: page.window,
    resolutionId,
    readyTimeoutMs: READY_TIMEOUT_MS,
    timers,
  });
}

/** Counts the `pagehide` listeners attached to `page`'s window, so a case can see each one removed. */
function countPageHideListeners(page: FakePage): () => number {
  const attached = new Set<unknown>();
  const original = { ...page.window };
  page.window.addEventListener = (...args: Parameters<EventTarget['addEventListener']>): void => {
    if (args[0] === 'pagehide') {
      attached.add(args[1]);
    }
    original.addEventListener(...args);
  };
  page.window.removeEventListener = (...args: Parameters<EventTarget['removeEventListener']>): void => {
    if (args[0] === 'pagehide') {
      attached.delete(args[1]);
    }
    original.removeEventListener(...args);
  };
  return () => attached.size;
}

/** Settles with the first end a frame status hears. */
function waitForFirstEnd(status: FrameStatus): Promise<FrameStatusEnd> {
  return new Promise(resolve => {
    status.handler(undefined, { hello: { resolutionId: null } }, { send: () => undefined, interrupt: resolve });
  });
}

describe('connectSharedWorker', () => {
  it('As a tab on the shared light client, I link to the worker and my frame is up once the worker says it is ready', async () => {
    // Given
    const worker = createFakeWorker();
    const linked = link(worker);

    // When the worker says it is ready, and the tab sends a heartbeat once linked
    worker.status.markReady();
    await linked.ready;
    const answer = linked.transport.request(frame.heartbeat, undefined);

    // Then the link resolved with a transport that reaches the worker
    await expect(answer).resolves.toEqual(ok());
  });

  it('As a tab whose SharedWorker fails to start, I link to it and my frame fails at once with why', async () => {
    // Given
    const worker = createFakeWorker();
    const linked = link(worker);

    // When
    worker.failToStart('script error');

    // Then
    await expect(linked.ready).rejects.toThrow('SharedWorker failed to start: script error');
  });

  it('As a tab whose worker cannot sync, I link to it and my frame fails with the error the worker gave', async () => {
    // Given
    const worker = createFakeWorker();
    const linked = link(worker);

    // When
    worker.status.fail(new ProtocolInitFailedError('chainHead follow stopped'));

    // Then
    await expect(linked.ready).rejects.toMatchObject({
      name: 'ProtocolInitFailedError',
      message: 'chainHead follow stopped',
    });
  });

  it("As a tab whose worker died while it synced, I link to it and my frame fails with the worker's fatal, not a failed boot", async () => {
    // Given a frame that hears the worker's status through the subscription it is handed, and fails its boot when the
    // link fails
    const worker = createFakeWorker();
    const frameStatus = createFrameStatus();
    const failed = waitForFirstEnd(frameStatus);
    const linked = link(worker);
    linked.status.onEnd(end => {
      frameStatus.fail(getWorkerEndError(end));
    });
    void linked.ready.catch((error: unknown) => {
      frameStatus.fail(new ProtocolInitFailedError(String(error)));
    });

    // When the worker's light client dies before it is ready
    worker.status.fail(new ProtocolFatalError('wasm trap'));

    // Then the frame fails with the fatal
    await expect(failed).resolves.toEqual(err(domain({ tag: 'fatal', value: 'wasm trap' })));
  });

  it('As a tab whose worker never says ready, I wait out the ready wait and my frame fails and lets go of the worker', async () => {
    // Given a link whose status the frame was handed
    const timers = createManualTimers();
    const worker = createFakeWorker();
    const handed = createDeferred<WorkerEnd>();
    const linked = link(worker, { timers });
    linked.status.onEnd(handed.resolve);
    const failed = linked.ready.catch((error: unknown) => error);
    await worker.statusHeard;

    // When
    await timers.advance(READY_TIMEOUT_MS);

    // Then the link fails as a failed init, the frame hears the same, and the worker hears the port close
    const timeout = { name: 'ProtocolInitFailedError', message: PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT };
    await expect(failed).resolves.toMatchObject(timeout);
    await expect(handed.promise.then(getWorkerEndError)).resolves.toMatchObject(timeout);
    await worker.portClosed;
  });

  it.each([
    {
      case: 'is ready',
      outcome: { outcome: 'ok' },
      act(worker: FakeWorker): Promise<void> {
        worker.status.markReady();
        return Promise.resolve();
      },
    },
    {
      case: 'never says ready',
      outcome: { outcome: 'timeout' },
      act(_worker: FakeWorker, timers: ManualTimers): Promise<void> {
        return timers.advance(READY_TIMEOUT_MS);
      },
    },
    {
      case: 'reports a failure',
      outcome: { outcome: 'error', reason: 'worker_reported' },
      act(worker: FakeWorker): Promise<void> {
        worker.status.fail(new ProtocolInitFailedError('chainHead follow stopped'));
        return Promise.resolve();
      },
    },
    {
      case: 'fails to load',
      outcome: { outcome: 'error', reason: 'load_failed' },
      act(worker: FakeWorker): Promise<void> {
        worker.failToStart('script error');
        return Promise.resolve();
      },
    },
  ])('As a dotli operator, I watch a worker that $case and see its ready wait timed under its outcome', async row => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const timers = createManualTimers();
    const worker = createFakeWorker();
    const linked = link(worker, { timers }).ready.catch(() => undefined);

    // When
    await row.act(worker, timers);
    await linked;

    // Then
    expect(metrics.distributions.filter(d => d.name === 'dotli.protocol.sw_ready').map(d => d.attributes)).toEqual([
      row.outcome,
    ]);
  });

  it('As a dotli operator, I watch a worker that never answers the handshake and see one ready timeout counted, with one deadline', async () => {
    // Given a worker whose port nothing answers on
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const timers = createManualTimers();
    const channel = new MessageChannel();
    channels.add(channel);
    const silent = Object.assign(new EventTarget(), { port: channel.port2 });
    const failed = connectSharedWorker({
      worker: silent,
      page: createFakePage().window,
      resolutionId: null,
      readyTimeoutMs: READY_TIMEOUT_MS,
      timers,
    }).ready.catch((error: unknown) => error);

    // When the ready wait runs out, where a handshake deadline of the same length would tie with it
    await timers.advance(READY_TIMEOUT_MS);

    // Then the wait fails as its own timeout, and is counted once as one
    await expect(failed).resolves.toMatchObject({
      name: 'ProtocolInitFailedError',
      message: PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT,
    });
    expect(metrics.distributions.filter(d => d.name === 'dotli.protocol.sw_ready').map(d => d.attributes)).toEqual([
      { outcome: 'timeout' },
    ]);
  });

  it('As a dotli maintainer, I watch a SharedWorker fail after it was ready and see it reported, since nothing waits on it', async () => {
    // Given a worker that is ready
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const worker = createFakeWorker();
    const linked = link(worker);
    worker.status.markReady();
    await linked.ready;

    // When
    worker.failToStart('late script error');

    // Then the late failure was captured once and counted once
    expect(captured.map(capture => capture.step)).toEqual(['shared_worker_error']);
    expect(metrics.counted('protocol.shared_worker_error')).toEqual([
      { outcome: 'error', reason: 'ProtocolInitFailedError' },
    ]);
  });

  it('As a dotli maintainer, I watch a SharedWorker fail to load after its ready wait ran out and see no failure after ready reported', async () => {
    // Given a link whose ready wait ran out
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const timers = createManualTimers();
    const worker = createFakeWorker();
    const failed = link(worker, { timers }).ready.catch(() => undefined);
    await worker.statusHeard;
    await timers.advance(READY_TIMEOUT_MS);
    await failed;

    // When the worker's script then fails to load
    worker.failToStart('late script error');

    // Then nothing is captured, nothing is counted as a failure after ready, and the ready wait holds only its one timeout
    expect(captured.map(capture => capture.step)).toEqual([]);
    expect(metrics.counted('protocol.shared_worker_error')).toEqual([]);
    expect(metrics.distributions.filter(d => d.name === 'dotli.protocol.sw_ready').map(d => d.attributes)).toEqual([
      { outcome: 'timeout' },
    ]);
  });

  it('As a tab on the shared light client, I hear each beat of the worker and answer it with a heartbeat from my page load', async () => {
    // Given a tab linked while the worker still syncs, whose timers never run
    const worker = createFakeWorker();
    const linked = link(worker, { resolutionId: 'load-1' });
    await worker.beatsHeard;

    // When the worker beats while it syncs, and again once it is ready
    const first = worker.waitForHeartbeat();
    worker.beatTab();
    await first;
    worker.status.markReady();
    await linked.ready;
    const second = worker.waitForHeartbeat();
    worker.beatTab();
    await second;

    // Then the worker heard a heartbeat for each beat, from this page load
    expect(worker.heartbeats).toEqual(['load-1', 'load-1']);
  });

  it('As a tab whose worker gets ready while my heartbeat waits for its answer, my frame is up without waiting on it', async () => {
    // Given a tab whose heartbeat to the syncing worker is held
    const worker = createFakeWorker();
    const linked = link(worker);
    await worker.beatsHeard;
    worker.holdHeartbeats();
    const asked = worker.waitForHeartbeat();
    worker.beatTab();
    await asked;

    // When the worker says it is ready
    worker.status.markReady();

    // Then the ready wait resolves while the heartbeat is still held
    await expect(linked.ready).resolves.toBeUndefined();
  });

  it('As a dotli maintainer, I watch the worker refuse a heartbeat and see it reported once while the tab stops answering', async () => {
    // Given a tab on a ready worker that refuses heartbeats
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const worker = createFakeWorker();
    const linked = link(worker);
    worker.status.markReady();
    await linked.ready;
    const { transport } = linked;
    await worker.beatsHeard;
    worker.refuseHeartbeats();

    // When the worker beats twice, with a round trip after each
    const refused = worker.waitForHeartbeat();
    worker.beatTab();
    await refused;
    await transport.request(frame.warmup, undefined);
    worker.beatTab();
    // A heartbeat answering the second beat would reach the worker within these two round trips.
    await transport.request(frame.warmup, undefined);
    await transport.request(frame.warmup, undefined);

    // Then the refusal was captured and counted once, and the second beat went unanswered
    expect(captured.map(capture => capture.step)).toEqual(['worker_heartbeat']);
    expect(metrics.counted('protocol.worker_heartbeat')).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(worker.heartbeats).toHaveLength(1);
  });

  it('As a tab that leaves for good, I hide my page and my worker transport is disposed', async () => {
    // Given a tab on a ready worker
    const page = createFakePage();
    const worker = createFakeWorker();
    const linked = link(worker, { page });
    worker.status.markReady();
    await linked.ready;
    const { transport } = linked;

    // When its page hides for good, and the tab then sends a heartbeat
    page.hide(false);
    const answer = transport.request(frame.heartbeat, undefined);

    // Then its transport is closed, and the worker hears its port close
    await expect(answer).rejects.toThrow(PROTOCOL_APP_ERRORS.PORT_CLOSED);
    await worker.portClosed;
  });

  it("As a tab that let go of its link, I answer no more beats and my page's pagehide does nothing more", async () => {
    // Given a tab on a ready worker that answered one beat
    const page = createFakePage();
    const worker = createFakeWorker();
    const linked = link(worker, { page });
    worker.status.markReady();
    await linked.ready;
    await worker.beatsHeard;
    const answered = worker.waitForHeartbeat();
    worker.beatTab();
    await answered;

    // When the tab lets go of its link twice, the worker beats once its port closed, and the page hides for good
    linked.dispose();
    const thrownByDispose = catchError(() => {
      linked.dispose();
    });
    await worker.portClosed;
    worker.beatTab();
    const thrownByPageHide = catchError(() => {
      page.hide(false);
    });

    // Then the later beat went unanswered, and neither the second dispose nor the pagehide threw
    expect(worker.heartbeats).toHaveLength(1);
    expect(thrownByDispose).toBeUndefined();
    expect(thrownByPageHide).toBeUndefined();
  });

  it('As a tab that let go of its link, I leave no pagehide listener on my page, whether I let go once or twice', async () => {
    // Given a tab linked to a ready worker, whose page listeners are counted
    const page = createFakePage();
    const countListeners = countPageHideListeners(page);
    const worker = createFakeWorker();
    const linked = link(worker, { page });
    worker.status.markReady();
    await linked.ready;
    const whileLinked = countListeners();

    // When the tab lets go of its link twice
    linked.dispose();
    linked.dispose();

    // Then the page listened while the tab was linked, and no listener is left
    expect(whileLinked).toBe(1);
    expect(countListeners()).toBe(0);
  });

  it('As a tab whose ready wait failed, I let go of my link and nothing throws', async () => {
    // Given a tab whose worker never said ready, so the link failed
    const timers = createManualTimers();
    const worker = createFakeWorker();
    const linked = link(worker, { timers });
    const failed = linked.ready.catch((error: unknown) => error);
    await worker.statusHeard;
    await timers.advance(READY_TIMEOUT_MS);
    await failed;

    // When the tab lets go of its link
    const thrown = catchError(() => {
      linked.dispose();
    });

    // Then nothing throws
    expect(thrown).toBeUndefined();
  });

  it('As a dotli maintainer, I watch a SharedWorker fail after its tab let go of the link and see nothing reported', async () => {
    // Given a tab that let go of its link to a ready worker
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const worker = createFakeWorker();
    const linked = link(worker);
    worker.status.markReady();
    await linked.ready;
    linked.dispose();

    // When the worker's script then fails
    worker.failToStart('late script error');

    // Then nothing is captured
    expect(captured.map(capture => capture.step)).toEqual([]);
  });

  it('As a tab that let go of its link before the worker was ready, I hear the ready wait fail', async () => {
    // Given a tab whose worker still syncs
    const worker = createFakeWorker();
    const linked = link(worker);
    const failed = linked.ready.catch((error: unknown) => error);
    await worker.statusHeard;

    // When the tab lets go of its link
    linked.dispose();

    // Then the ready wait failed as the port closed, and the worker hears its port close
    await expect(failed).resolves.toMatchObject({ message: PROTOCOL_APP_ERRORS.PORT_CLOSED });
    await worker.portClosed;
  });

  it('As a tab whose worker script still loads, I let go of my link and my ready wait fails at once as the port closed', async () => {
    // Given a worker whose port nothing answers on yet, and timers that never run
    const channel = new MessageChannel();
    channels.add(channel);
    const linked = connectSharedWorker({
      worker: Object.assign(new EventTarget(), { port: channel.port2 }),
      page: createFakePage().window,
      resolutionId: null,
      readyTimeoutMs: READY_TIMEOUT_MS,
      timers: createManualTimers(),
    });
    const failed = linked.ready.catch((error: unknown) => error);

    // When
    linked.dispose();

    // Then
    await expect(failed).resolves.toMatchObject({ message: PROTOCOL_APP_ERRORS.PORT_CLOSED });
  });

  it('As a tab whose worker stopped serving it, I stop answering its beats and a heartbeat it then fails is not reported', async () => {
    // Given a ready tab whose last heartbeat the worker holds
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const worker = createFakeWorker();
    const linked = link(worker);
    worker.status.markReady();
    await linked.ready;
    const { transport } = linked;
    await worker.beatsHeard;
    worker.holdHeartbeats();
    const asked = worker.waitForHeartbeat();
    worker.beatTab();
    await asked;

    // When the worker ends my status, fails the held heartbeat and beats again, with round trips after each
    worker.status.fail(new ProtocolFatalError('wasm trap'));
    await transport.request(frame.warmup, undefined);
    worker.failHeld(new Error('heartbeat dropped'));
    await transport.request(frame.warmup, undefined);
    worker.beatTab();
    await transport.request(frame.warmup, undefined);
    await transport.request(frame.warmup, undefined);

    // Then the later beat went unanswered, and the failed heartbeat was not captured
    expect(worker.heartbeats).toHaveLength(1);
    expect(captured.map(capture => capture.step)).toEqual([]);
  });

  it('As a tab whose worker refuses to drop my listener, I let go of my link before ready and the failure is reported, not thrown, while my ready wait still fails and my page keeps no pagehide listener', async () => {
    // Given a tab whose worker still syncs, and throws when a listener is removed
    const reports = recordReports({ onFinished: onTestFinished });
    const page = createFakePage();
    const countListeners = countPageHideListeners(page);
    const worker = createFakeWorker();
    const linked = link(worker, { page });
    const failed = linked.ready.catch((error: unknown) => error);
    await worker.statusHeard;
    worker.refuseListenerRemoval(new Error('listener removal failed'));

    // When
    const thrown = catchError(() => {
      linked.dispose();
    });

    // Then
    expect(thrown).toBeUndefined();
    expect(reports.exceptions).toMatchObject([{ step: 'transition' }]);
    expect(countListeners()).toBe(0);
    await expect(failed).resolves.toMatchObject({ message: PROTOCOL_APP_ERRORS.PORT_CLOSED });
  });
});
