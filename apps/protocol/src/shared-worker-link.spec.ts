// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The worker is a serving transport on the far end of a real port pair, so the link speaks to it over the wire.

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import {
  createPortProvider,
  createServingTransport,
  ProtocolFatalError,
  ProtocolInitFailedError,
  type ConsumerTransport,
  type ServingTransport,
  type SubscriptionSink,
} from '@dotli/protocol';
import { deferred, manualTimers, type ManualTimers } from '@dotli/shared/testing';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { createFrameStatus, type FrameStatus } from './frame-status.js';
import { connectSharedWorker } from './shared-worker-link.js';

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
  /** Settles once the tab's status subscription on the worker stops. */
  statusStopped: Promise<void>;
  serving: ServingTransport;
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
  const serving = createServingTransport(createPortProvider(channel.port1), { side: 'worker', count: () => 0 });
  const status = createFrameStatus();
  const stopped = deferred<undefined>();
  serving.handleSubscription('frameStatus', (payload, context, sink) => {
    const stop = status.handler(payload, context, sink);
    return () => {
      stop();
      stopped.resolve(undefined);
    };
  });
  const heartbeats: (string | null)[] = [];
  let beat = deferred<undefined>();
  let refusing = false;
  serving.handleRequest('heartbeat', (_payload, context) => {
    heartbeats.push(context.resolutionId);
    beat.resolve(undefined);
    beat = deferred<undefined>();
    if (refusing) {
      throw new Error('heartbeat refused');
    }
    return undefined;
  });
  const beatSinks = new Set<SubscriptionSink<'beat'>>();
  const beatsHeard = deferred<undefined>();
  serving.handleSubscription('beat', (_payload, _context, sink) => {
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
        sink.send(undefined);
      }
    },
    refuseHeartbeats: () => {
      refusing = true;
    },
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
    onOpen?: (transport: ConsumerTransport) => void;
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

/** The first failure a frame status hears. */
function firstFailure(status: FrameStatus): Promise<Error | undefined> {
  return new Promise(resolve => {
    status.handler(
      undefined,
      { origin: null, deadlineMs: null, resolutionId: null },
      { send: () => undefined, end: resolve },
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
    await expect(transport.request('heartbeat', undefined)).resolves.toBeUndefined();
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
    // Given a frame that hears the worker's status through the transport it is handed, and fails its boot when the
    // link fails
    const worker = fakeWorker();
    const frame = createFrameStatus();
    const failed = firstFailure(frame);
    const linked = link(worker, {
      onOpen: transport => {
        transport
          .subscribe('frameStatus', undefined, () => undefined)
          .onEnd(error => {
            frame.fail(error ?? new Error('ended'));
          });
      },
    });
    void linked.catch((error: unknown) => {
      frame.fail(new ProtocolInitFailedError(String(error)));
    });

    // When the worker's light client dies before it is ready
    worker.status.fail(new ProtocolFatalError('wasm trap'));

    // Then the frame fails with the fatal
    await expect(failed).resolves.toMatchObject({ name: 'ProtocolFatalError', message: 'wasm trap' });
  });

  it('As a tab whose worker never says ready, my frame fails after the ready wait', async () => {
    // Given
    const timers = manualTimers();
    const worker = fakeWorker();
    const linked = link(worker, { timers }).catch((err: unknown) => err);

    // When
    await timers.advance(READY_TIMEOUT_MS);

    // Then
    await expect(linked).resolves.toMatchObject({ message: PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT });
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
    await transport.request('warmup', undefined).catch(() => undefined);
    worker.beatTab();
    // A heartbeat answering the second beat would reach the worker within these two round trips.
    await transport.request('warmup', undefined).catch(() => undefined);
    await transport.request('warmup', undefined).catch(() => undefined);

    // Then the refusal was captured once, and the second beat went unanswered
    expect(exceptions).toEqual(['worker_heartbeat']);
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
    await expect(transport.request('heartbeat', undefined)).resolves.toBeUndefined();
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
    await expect(transport.request('heartbeat', undefined)).rejects.toThrow(PROTOCOL_APP_ERRORS.PORT_CLOSED);
    await worker.statusStopped;
  });
});
