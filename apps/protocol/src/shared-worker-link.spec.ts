// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The worker is a transport on the far end of a real port pair, so the link speaks to it over the wire.

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink, spans as S } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import {
  protocolSchema,
  ProtocolFatalError,
  ProtocolInitFailedError,
  type FrameFailure,
  type ProtocolTransport,
} from '@dotli/protocol';
import { deferred, manualTimers, type ManualTimers } from '@dotli/shared/testing';
import {
  createPortProvider,
  createTransport,
  domain,
  err,
  ok,
  unsupported,
  type CallError,
  type DomainError,
  type MethodTypes,
  type Sink,
} from '@dotli/transport';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { createFrameStatus, type FrameStatus } from './frame-status.js';
import { connectSharedWorker, workerEndError, type WorkerEnd, type WorkerStatus } from './shared-worker-link.js';

const { frame } = protocolSchema.traits;

const READY_TIMEOUT_MS = 30_000;

interface FakeWorker {
  worker: Pick<SharedWorker, 'port' | 'addEventListener'>;
  /** The worker's own status, which its serving end reports. */
  status: FrameStatus;
  /** The resolution id of each heartbeat the worker heard, in order. */
  heartbeats: (string | null)[];
  /** Settles on the next heartbeat the worker hears. */
  nextHeartbeat: () => Promise<void>;
  /** Settles once the tab subscribed to the worker's beats. */
  beatsHeard: Promise<void>;
  /** The worker's heartbeat clock ticks, so it beats on every open beat subscription. */
  beatTab: () => void;
  /** Makes each later heartbeat fail on the worker. */
  refuseHeartbeats: () => void;
  /** Leaves each later heartbeat unanswered until `failHeld`. */
  holdHeartbeats: () => void;
  /** Fails every heartbeat held so far. */
  failHeld: (error: Error) => void;
  /** Settles once the tab's status subscription reached the worker. */
  statusHeard: Promise<void>;
  /** Settles once the tab's status subscription on the worker stops. */
  statusStopped: Promise<void>;
  serving: ProtocolTransport;
  /** The worker script failing to load. */
  failToStart: (message: string) => void;
}

const channels = new Set<MessageChannel>();

afterEach(() => {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  channels.clear();
});

function fakeWorker(): FakeWorker {
  const channel = new MessageChannel();
  channels.add(channel);
  const serving = createTransport(protocolSchema, createPortProvider(channel.port1), {
    handshake: 'accept',
    hello: { resolutionId: null },
  });
  const status = createFrameStatus();
  const stopped = deferred<undefined>();
  const statusHeard = deferred<undefined>();
  serving.handleSubscription(frame.status, (start, context, sink) => {
    statusHeard.resolve(undefined);
    const stop = status.handler(start, context, sink);
    return () => {
      stop();
      stopped.resolve(undefined);
    };
  });
  const heartbeats: (string | null)[] = [];
  let beat = deferred<undefined>();
  let refusing = false;
  let holding = false;
  const held = deferred<undefined>();
  serving.handleRequest(frame.heartbeat, (_payload, context) => {
    heartbeats.push(context.hello.resolutionId);
    beat.resolve(undefined);
    beat = deferred<undefined>();
    if (refusing) {
      throw new Error('heartbeat refused');
    }
    return holding ? held.promise.then(() => ok()) : ok();
  });
  const beatSinks = new Set<Sink<MethodTypes<typeof frame.beat>['receive'], DomainError<typeof frame.beat>>>();
  const beatsHeard = deferred<undefined>();
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
    worker,
    status,
    heartbeats,
    nextHeartbeat: () => beat.promise,
    beatsHeard: beatsHeard.promise,
    beatTab: () => {
      for (const sink of [...beatSinks]) {
        sink.receive(undefined);
      }
    },
    refuseHeartbeats: () => {
      refusing = true;
    },
    holdHeartbeats: () => {
      holding = true;
    },
    failHeld: error => {
      held.reject(error);
    },
    statusHeard: statusHeard.promise,
    statusStopped: stopped.promise,
    serving,
    failToStart: message => {
      workerTarget.dispatchEvent(new ErrorEvent('error', { message }));
    },
  };
}

/** The iframe's page, which hides when the host removes the frame, the tab navigates or the page enters the cache. */
function framePage(): { target: EventTarget; hide: (persisted: boolean) => void } {
  const target = new EventTarget();
  return {
    target,
    hide: persisted => {
      target.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));
    },
  };
}

function link(
  fake: FakeWorker,
  options: {
    page?: ReturnType<typeof framePage>;
    timers?: ManualTimers;
    resolutionId?: string | null;
    onOpen?: (transport: ProtocolTransport, status: WorkerStatus) => void;
  } = {},
): ReturnType<typeof connectSharedWorker> {
  return connectSharedWorker({
    worker: fake.worker,
    window: (options.page ?? framePage()).target,
    resolutionId: options.resolutionId ?? null,
    readyTimeoutMs: READY_TIMEOUT_MS,
    timers: options.timers ?? manualTimers(),
    ...(options.onOpen === undefined ? {} : { onOpen: options.onOpen }),
  });
}

/** The first end a frame status hears. */
function firstEnd(status: FrameStatus): Promise<CallError<FrameFailure> | undefined> {
  return new Promise(resolve => {
    status.handler(
      undefined,
      { origin: null, hello: { resolutionId: null } },
      { receive: () => undefined, interrupt: resolve },
    );
  });
}

describe('connectSharedWorker', () => {
  it('As a tab on the shared light client, my frame is up once the worker says it is ready', async () => {
    // Given
    const worker = fakeWorker();
    const linked = link(worker);

    // When
    worker.status.ready();

    // Then the link resolves with a transport that reaches the worker
    const transport = await linked;
    await expect(transport.request(frame.heartbeat, undefined)).resolves.toEqual(ok());
  });

  it('As a tab whose SharedWorker fails to start, my frame fails at once with why', async () => {
    // Given
    const worker = fakeWorker();
    const linked = link(worker);

    // When
    worker.failToStart('script error');

    // Then
    await expect(linked).rejects.toThrow('SharedWorker failed to start: script error');
  });

  it('As a tab whose worker cannot sync, my frame fails with the error the worker gave', async () => {
    // Given
    const worker = fakeWorker();
    const linked = link(worker);

    // When
    worker.status.fail(new ProtocolInitFailedError('chainHead follow stopped'));

    // Then
    await expect(linked).rejects.toMatchObject({
      name: 'ProtocolInitFailedError',
      message: 'chainHead follow stopped',
    });
  });

  it("As a tab whose worker died while it synced, my frame fails with the worker's fatal and not a failed boot", async () => {
    // Given a frame that hears the worker's status through the subscription it is handed, and fails its boot when the
    // link fails
    const worker = fakeWorker();
    const frameStatus = createFrameStatus();
    const failed = firstEnd(frameStatus);
    const linked = link(worker, {
      onOpen: (_transport, status) => {
        status.onEnd(end => {
          frameStatus.fail(workerEndError(end));
        });
      },
    });
    void linked.catch((error: unknown) => {
      frameStatus.fail(new ProtocolInitFailedError(String(error)));
    });

    // When the worker's light client dies before it is ready
    worker.status.fail(new ProtocolFatalError('wasm trap'));

    // Then the frame fails with the fatal
    await expect(failed).resolves.toEqual(domain({ tag: 'fatal', value: 'wasm trap' }));
  });

  it('As a tab whose worker never says ready, my frame fails after the ready wait and lets go of the worker', async () => {
    // Given a link whose status the frame was handed
    const timers = manualTimers();
    const worker = fakeWorker();
    const handed = deferred<WorkerEnd>();
    const linked = link(worker, {
      timers,
      onOpen: (_transport, status) => {
        status.onEnd(handed.resolve);
      },
    }).catch((err: unknown) => err);
    await worker.statusHeard;

    // When
    await timers.advance(READY_TIMEOUT_MS);

    // Then the link fails as a failed init, the frame hears the same, and the worker hears the status subscription stop
    const timeout = { name: 'ProtocolInitFailedError', message: PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT };
    await expect(linked).resolves.toMatchObject(timeout);
    await expect(handed.promise.then(workerEndError)).resolves.toMatchObject(timeout);
    await worker.statusStopped;
  });

  it.each([
    {
      case: 'is ready',
      outcome: { outcome: 'ok' },
      act: (worker: FakeWorker): Promise<void> => {
        worker.status.ready();
        return Promise.resolve();
      },
    },
    {
      case: 'never says ready',
      outcome: { outcome: 'timeout' },
      act: (_worker: FakeWorker, timers: ManualTimers): Promise<void> => timers.advance(READY_TIMEOUT_MS),
    },
    {
      case: 'reports a failure',
      outcome: { outcome: 'error', reason: 'worker_reported' },
      act: (worker: FakeWorker): Promise<void> => {
        worker.status.fail(new ProtocolInitFailedError('chainHead follow stopped'));
        return Promise.resolve();
      },
    },
    {
      case: 'fails to load',
      outcome: { outcome: 'error', reason: 'load_failed' },
      act: (worker: FakeWorker): Promise<void> => {
        worker.failToStart('script error');
        return Promise.resolve();
      },
    },
  ])('As a dotli operator, I see the ready wait of a worker that $case timed under its outcome', async row => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const timers = manualTimers();
    const worker = fakeWorker();
    const linked = link(worker, { timers }).catch(() => undefined);

    // When
    await row.act(worker, timers);
    await linked;

    // Then
    expect(metrics.distributions.filter(d => d.name === `dotli.${S.PROTOCOL_SW_READY}`).map(d => d.attributes)).toEqual(
      [row.outcome],
    );
  });

  it('As a dotli maintainer, a SharedWorker that fails after it was ready is reported, since nothing waits on it', async () => {
    // Given a worker that is ready
    const exceptions: string[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: (_err, ctx) => {
          exceptions.push(ctx.step);
        },
        expected: () => undefined,
      }),
    );
    const worker = fakeWorker();
    const linked = link(worker);
    worker.status.ready();
    await linked;

    // When
    worker.failToStart('late script error');

    // Then the late failure was captured once
    expect(exceptions).toEqual(['shared_worker_error']);
  });

  it('As a tab on the shared light client, I answer each beat of the worker with a heartbeat from my page load', async () => {
    // Given a tab linked while the worker still syncs, whose timers never run
    const worker = fakeWorker();
    const linked = link(worker, { resolutionId: 'load-1' });
    await worker.beatsHeard;

    // When the worker beats while it syncs, and again once it is ready
    const first = worker.nextHeartbeat();
    worker.beatTab();
    await first;
    worker.status.ready();
    await linked;
    const second = worker.nextHeartbeat();
    worker.beatTab();
    await second;

    // Then the worker heard a heartbeat for each beat, from this page load
    expect(worker.heartbeats).toEqual(['load-1', 'load-1']);
  });

  it('As a dotli maintainer, a heartbeat the worker refuses is reported once, and the tab stops answering', async () => {
    // Given a tab on a ready worker that refuses heartbeats
    const exceptions: string[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: (_err, ctx) => {
          exceptions.push(ctx.step);
        },
        expected: () => undefined,
      }),
    );
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const worker = fakeWorker();
    const linked = link(worker);
    worker.status.ready();
    const transport = await linked;
    await worker.beatsHeard;
    worker.refuseHeartbeats();

    // When the worker beats twice, with a round trip after each
    const refused = worker.nextHeartbeat();
    worker.beatTab();
    await refused;
    await expect(transport.request(frame.warmup, undefined)).resolves.toEqual(err(unsupported()));
    worker.beatTab();
    // A heartbeat answering the second beat would reach the worker within these two round trips.
    await transport.request(frame.warmup, undefined);
    await transport.request(frame.warmup, undefined);

    // Then the refusal was captured and counted once, and the second beat went unanswered
    expect(exceptions).toEqual(['worker_heartbeat']);
    expect(metrics.counted(S.PROTOCOL_WORKER_HEARTBEAT)).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(worker.heartbeats).toHaveLength(1);
  });

  it('As a tab kept in the back-forward cache, I keep my worker transport', async () => {
    // Given a tab on a ready worker
    const page = framePage();
    const worker = fakeWorker();
    const linked = link(worker, { page });
    worker.status.ready();
    const transport = await linked;

    // When its page enters the back-forward cache
    page.hide(true);

    // Then its transport still reaches the worker
    await expect(transport.request(frame.heartbeat, undefined)).resolves.toEqual(ok());
  });

  it('As a tab that leaves for good, I dispose my worker transport', async () => {
    // Given a tab on a ready worker
    const page = framePage();
    const worker = fakeWorker();
    const linked = link(worker, { page });
    worker.status.ready();
    const transport = await linked;

    // When its page hides for good
    page.hide(false);

    // Then its transport is closed, and the worker heard its subscription end
    await expect(transport.request(frame.heartbeat, undefined)).rejects.toThrow(PROTOCOL_APP_ERRORS.PORT_CLOSED);
    await worker.statusStopped;
  });

  it('As a tab whose worker stopped serving it, I stop answering its beats and a heartbeat it then fails is not reported', async () => {
    // Given a ready tab whose last heartbeat the worker holds
    const exceptions: string[] = [];
    onTestFinished(
      bindCaptureSink({
        exception: (_err, ctx) => {
          exceptions.push(ctx.step);
        },
        expected: () => undefined,
      }),
    );
    const worker = fakeWorker();
    const linked = link(worker);
    worker.status.ready();
    const transport = await linked;
    await worker.beatsHeard;
    worker.holdHeartbeats();
    const asked = worker.nextHeartbeat();
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
    expect(exceptions).toEqual([]);
  });
});
