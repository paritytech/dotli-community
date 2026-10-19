// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The worker is a transport on the far end of a real port pair, so the link speaks to it over the wire. For the relay,
// the host speaks to the iframe and the iframe to a fake worker, each over its own link, so every call crosses both
// hops on the wire.

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink, spans as S } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import {
  failureOf,
  protocolSchema,
  ProtocolFatalError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolVersionMismatchError,
  type FrameFailure,
  type ProtocolContext,
  type ProtocolTransport,
  type RemoteFailure,
  createFrameStatus,
  type FrameStatus,
  type FrameStatusEnd,
} from '@dotli/protocol';
import { deferred, toHex } from '@dotli/shared';
import { FakePage, manualTimers, type ManualTimers } from '@dotli/shared/testing';
import {
  TransportUnsupportedProtocolVersionError,
  createPortProvider,
  createTransport,
  denied,
  domain,
  err,
  hostFailure,
  malformedFrame,
  ok,
  unsupported,
  type CallError,
  type DomainError,
  type MethodTypes,
  type Sink,
} from '@dotli/transport';
import { readFrame } from '@dotli/transport/testing';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import {
  connectSharedWorker,
  registerWorkerRelay,
  watchWorkerStatus,
  workerEndError,
  type WorkerEnd,
} from './shared-worker-link.js';
import { closeHostLinks, linkHost, record, type EndOf, type HostLink } from './testing/host-link.js';

const { frame, resolve, chain } = protocolSchema.sections;

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
  /** Settles once the tab's end of the worker's port closes, which a closing transport does and tells nothing else. */
  portClosed: Promise<void>;
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
    handshake: 'respond',
    hello: { resolutionId: null },
  });
  const status = createFrameStatus();
  const statusHeard = deferred<undefined>();
  serving.handleSubscription(frame.status, (start, context, sink) => {
    statusHeard.resolve(undefined);
    return status.handler(start, context, sink);
  });
  const portClosed = deferred<undefined>();
  channel.port1.addEventListener('close', () => {
    portClosed.resolve(undefined);
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
        sink.send(undefined);
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
    portClosed: portClosed.promise,
    serving,
    failToStart: message => {
      workerTarget.dispatchEvent(new ErrorEvent('error', { message }));
    },
  };
}

function link(
  fake: FakeWorker,
  options: {
    page?: FakePage;
    timers?: ManualTimers;
    resolutionId?: string | null;
  } = {},
): ReturnType<typeof connectSharedWorker> {
  return connectSharedWorker({
    worker: fake.worker,
    window: (options.page ?? new FakePage()).window,
    resolutionId: options.resolutionId ?? null,
    readyTimeoutMs: READY_TIMEOUT_MS,
    timers: options.timers ?? manualTimers(),
  });
}

/** The first end a frame status hears. */
function firstEnd(status: FrameStatus): Promise<FrameStatusEnd> {
  return new Promise(resolve => {
    status.handler(undefined, { hello: { resolutionId: null } }, { send: () => undefined, interrupt: resolve });
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
    await linked.ready;
    const { transport } = linked;
    await expect(transport.request(frame.heartbeat, undefined)).resolves.toEqual(ok());
  });

  it('As a tab whose SharedWorker fails to start, my frame fails at once with why', async () => {
    // Given
    const worker = fakeWorker();
    const linked = link(worker);

    // When
    worker.failToStart('script error');

    // Then
    await expect(linked.ready).rejects.toThrow('SharedWorker failed to start: script error');
  });

  it('As a tab whose worker cannot sync, my frame fails with the error the worker gave', async () => {
    // Given
    const worker = fakeWorker();
    const linked = link(worker);

    // When
    worker.status.fail(new ProtocolInitFailedError('chainHead follow stopped'));

    // Then
    await expect(linked.ready).rejects.toMatchObject({
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
    const linked = link(worker);
    linked.status.onEnd(end => {
      frameStatus.fail(workerEndError(end));
    });
    void linked.ready.catch((error: unknown) => {
      frameStatus.fail(new ProtocolInitFailedError(String(error)));
    });

    // When the worker's light client dies before it is ready
    worker.status.fail(new ProtocolFatalError('wasm trap'));

    // Then the frame fails with the fatal
    await expect(failed).resolves.toEqual(err(domain({ tag: 'fatal', value: 'wasm trap' })));
  });

  it('As a tab whose worker never says ready, my frame fails after the ready wait and lets go of the worker', async () => {
    // Given a link whose status the frame was handed
    const timers = manualTimers();
    const worker = fakeWorker();
    const handed = deferred<WorkerEnd>();
    const linked = link(worker, { timers });
    linked.status.onEnd(handed.resolve);
    const failed = linked.ready.catch((err: unknown) => err);
    await worker.statusHeard;

    // When
    await timers.advance(READY_TIMEOUT_MS);

    // Then the link fails as a failed init, the frame hears the same, and the worker hears the port close
    const timeout = { name: 'ProtocolInitFailedError', message: PROTOCOL_APP_ERRORS.SHARED_WORKER_READY_TIMEOUT };
    await expect(failed).resolves.toMatchObject(timeout);
    await expect(handed.promise.then(workerEndError)).resolves.toMatchObject(timeout);
    await worker.portClosed;
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
    const linked = link(worker, { timers }).ready.catch(() => undefined);

    // When
    await row.act(worker, timers);
    await linked;

    // Then
    expect(metrics.distributions.filter(d => d.name === `dotli.${S.PROTOCOL_SW_READY}`).map(d => d.attributes)).toEqual(
      [row.outcome],
    );
  });

  it('As a dotli operator, I see a worker that never answers the handshake counted as a ready timeout, with one deadline', async () => {
    // Given a worker whose port nothing answers on
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const timers = manualTimers();
    const channel = new MessageChannel();
    channels.add(channel);
    const silent = Object.assign(new EventTarget(), { port: channel.port2 });
    const failed = connectSharedWorker({
      worker: silent,
      window: new FakePage().window,
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
    expect(metrics.distributions.filter(d => d.name === `dotli.${S.PROTOCOL_SW_READY}`).map(d => d.attributes)).toEqual(
      [{ outcome: 'timeout' }],
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
    await linked.ready;

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
    await linked.ready;
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
    await linked.ready;
    const { transport } = linked;
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
    const page = new FakePage();
    const worker = fakeWorker();
    const linked = link(worker, { page });
    worker.status.ready();
    await linked.ready;
    const { transport } = linked;

    // When its page enters the back-forward cache
    page.hide(true);

    // Then its transport still reaches the worker
    await expect(transport.request(frame.heartbeat, undefined)).resolves.toEqual(ok());
  });

  it('As a tab that leaves for good, I dispose my worker transport', async () => {
    // Given a tab on a ready worker
    const page = new FakePage();
    const worker = fakeWorker();
    const linked = link(worker, { page });
    worker.status.ready();
    await linked.ready;
    const { transport } = linked;

    // When its page hides for good
    page.hide(false);

    // Then its transport is closed, and the worker hears its port close
    await expect(transport.request(frame.heartbeat, undefined)).rejects.toThrow(PROTOCOL_APP_ERRORS.PORT_CLOSED);
    await worker.portClosed;
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
    await linked.ready;
    const { transport } = linked;
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

type Executable = MethodTypes<typeof resolve.executableManifest>;
type Root = MethodTypes<typeof resolve.rootManifest>;
type ExecutableAnswer = Extract<Executable['response'], { success: true }>;
type RootAnswer = Extract<Root['response'], { success: true }>;

interface Hops {
  host: ProtocolTransport;
  /** The worker's end, where a spec registers what the worker answers. */
  worker: ProtocolTransport;
  /** The iframe's end toward the worker, which the relay calls through. */
  link: ProtocolTransport;
  /** The worker's own status, which every subscription of the iframe's hears. */
  workerStatus: FrameStatus;
  /** Each call context the worker saw, by method. */
  contexts: Map<string, ProtocolContext>;
  /** Settles once the iframe's status subscription reached the worker, which reports itself ready. */
  workerStatusHeard: Promise<void>;
  /** The frames delivered on the host's link to the iframe, and on the iframe's link to the worker. */
  wire: { host: readonly Uint8Array[]; worker: readonly Uint8Array[] };
}

afterEach(() => {
  closeHostLinks();
});

/** Links a host to an iframe in shared-worker mode, whose worker answers with what `serveWorker` registers. */
function linkHops(serveWorker: (worker: ProtocolTransport, contexts: Map<string, ProtocolContext>) => void): Hops {
  const iframe: HostLink = linkHost();
  const { serving: worker, host: toWorker, delivered } = linkHost();
  const contexts = new Map<string, ProtocolContext>();
  serveWorker(worker, contexts);
  const workerStatus = createFrameStatus();
  const heard = deferred<undefined>();
  worker.handleSubscription(frame.status, (start, context, sink) => {
    const stop = workerStatus.handler(start, context, sink);
    heard.resolve(undefined);
    return stop;
  });
  workerStatus.ready();
  const status = createFrameStatus();
  iframe.serving.handleSubscription(frame.status, status.handler);
  // The iframe's link holds the one status subscription to the worker and shares it with the relay.
  registerWorkerRelay(
    iframe.serving,
    toWorker,
    watchWorkerStatus(toWorker, () => undefined),
    {
      ...status,
      serveTelemetry: source => {
        iframe.serving.handleSubscription(frame.telemetry, source);
      },
    },
  );
  status.ready();
  return {
    host: iframe.host,
    worker,
    link: toWorker,
    workerStatus,
    contexts,
    workerStatusHeard: heard.promise.then(() => undefined),
    wire: { host: iframe.delivered, worker: delivered },
  };
}

/** The worker's link context, which carries nothing of the host's call. */
const LINK_CONTEXT = { hello: { resolutionId: null } };

/** The message bytes of each chain value among `frames`. */
function chainValues(frames: readonly Uint8Array[]): Uint8Array[] {
  return frames.flatMap(data => {
    const read = readFrame(protocolSchema, data);
    return read.kind === 'call' &&
      read.section === 'chain' &&
      read.method === 'connect' &&
      read.decoded?.tag === 'receive'
      ? [read.message]
      : [];
  });
}

/** One end the host heard, under the call it ended. */
interface HeardEnd {
  call: string;
  end: EndOf<unknown>;
}

describe('the worker relay', () => {
  it('As the host in shared-worker mode, my chain and resolve calls reach the worker and its answers reach me', async () => {
    // Given a worker that serves a chain, names and telemetry
    const sent: string[] = [];
    const { host, contexts } = linkHops((worker, seen) => {
      worker.handleSubscription(chain.connect, (_start, context, sink) => {
        seen.set('chain.connect', context);
        sink.send({ tag: 'connected', value: undefined });
        return () => undefined;
      });
      worker.handleRequest(chain.send, ({ message }) => {
        sent.push(message);
        return ok();
      });
      worker.handleRequest(resolve.owner, ({ label }, context) => {
        seen.set('resolve.owner', context);
        return ok(label === 'doom' ? '0xowner' : null);
      });
      worker.handleRequest(frame.warmup, () => ok());
      worker.handleSubscription(resolve.dotName, (_start, _context, sink) => {
        sink.send({ tag: 'phase', value: 'resolving-content' });
        sink.send({ tag: 'resolved', value: 'bafycid' });
        sink.interrupt(ok());
        return () => undefined;
      });
      worker.handleSubscription(frame.telemetry, (_start, _context, sink) => {
        sink.send({ tag: 'netBytes', value: 4_000 });
        return () => undefined;
      });
    });

    // When the host connects a chain, sends on it, resolves a name and its owner, and hears telemetry
    const connected = record(host, chain.connect, { genesisHash: '0xaa', connectionId: 'c1' });
    await connected.until(1);
    const sentAnswer = await host.request(chain.send, { connectionId: 'c1', message: '{"jsonrpc":"2.0"}' });
    const owner = await host.request(resolve.owner, { label: 'doom' });
    const warmed = await host.request(frame.warmup, undefined);
    const name = record(host, resolve.dotName, { label: 'doom' });
    const telemetry = record(host, frame.telemetry, undefined);
    await telemetry.until(1);

    // Then the worker's answers, values and ends reached the host, and the worker heard nothing of the host's call
    expect(connected.events).toEqual([{ tag: 'connected', value: undefined }]);
    expect(sent).toEqual(['{"jsonrpc":"2.0"}']);
    expect([sentAnswer, owner, warmed]).toEqual([ok(), ok('0xowner'), ok()]);
    await expect(name.ended).resolves.toEqual(ok());
    expect(name.events).toEqual([
      { tag: 'phase', value: 'resolving-content' },
      { tag: 'resolved', value: 'bafycid' },
    ]);
    expect(telemetry.events).toEqual([{ tag: 'netBytes', value: 4_000 }]);
    expect(contexts.get('chain.connect')).toEqual(LINK_CONTEXT);
    expect(contexts.get('resolve.owner')).toEqual(LINK_CONTEXT);
  });

  it('As the host in shared-worker mode, my manifest reads reach the worker and its answers reach me', async () => {
    // Given a worker that serves both manifest reads
    const executableAnswer: ExecutableAnswer['value'] = {
      kind: 'ok',
      value: { $v: 1, kind: 'worker', appVersion: [1, 0, 0], entrypoint: 'worker.js', includes: { chat: true } },
      raw: '{"$v":1}',
    };
    const rootAnswer: RootAnswer['value'] = { kind: 'unsupported', reason: 'no slot' };
    const asked: (Executable['request'] | Root['request'])[] = [];
    const { host, contexts } = linkHops((served, seen) => {
      served.handleRequest(resolve.executableManifest, (payload, context) => {
        asked.push(payload);
        seen.set('resolve.executableManifest', context);
        return ok(executableAnswer);
      });
      served.handleRequest(resolve.rootManifest, (payload, context) => {
        asked.push(payload);
        seen.set('resolve.rootManifest', context);
        return ok(rootAnswer);
      });
    });

    // When
    const executable = await host.request(resolve.executableManifest, { label: 'doom', kind: 'worker' });
    const root = await host.request(resolve.rootManifest, { label: 'doom' });

    // Then
    expect(executable).toEqual(ok(executableAnswer));
    expect(root).toEqual(ok(rootAnswer));
    expect(asked).toEqual([{ label: 'doom', kind: 'worker' }, { label: 'doom' }]);
    expect(contexts.get('resolve.executableManifest')).toEqual(LINK_CONTEXT);
    expect(contexts.get('resolve.rootManifest')).toEqual(LINK_CONTEXT);
  });

  it('As the host, my disconnect reaches the worker', async () => {
    // Given a chain the worker holds for the host
    let stopped: () => void = () => undefined;
    const disconnected = new Promise<void>(done => {
      stopped = done;
    });
    const { host } = linkHops(worker => {
      worker.handleSubscription(chain.connect, (_start, _context, sink) => {
        sink.send({ tag: 'connected', value: undefined });
        return stopped;
      });
    });
    const connected = record(host, chain.connect, { genesisHash: '0xaa', connectionId: 'c1' });
    await connected.until(1);

    // When the host disconnects
    connected.unsubscribe();

    // Then the worker stops the chain
    await disconnected;
  });

  it("As a dotli maintainer, a call the worker fails reaches the host under the worker's error name", async () => {
    // Given a worker whose owner read fails
    const { host } = linkHops(worker => {
      worker.handleRequest(resolve.owner, () => {
        throw new TypeError('storage read failed');
      });
    });

    // When the host asks for an owner
    const owner = await host.request(resolve.owner, { label: 'doom' });

    // Then the host hears the worker's failure as the worker answered it
    expect(owner).toEqual(err(hostFailure('TypeError: storage read failed')));
  });

  it('As the host, a request the worker answers with a failure reaches me through the iframe unchanged', async () => {
    // Given a worker whose reads fail in each way a handler can answer
    const syncTimeout: CallError<RemoteFailure> = domain({ tag: 'syncTimeout', value: 'Asset Hub did not sync' });
    const { host } = linkHops(worker => {
      worker.handleRequest(resolve.owner, () => err(syncTimeout));
      worker.handleRequest(resolve.rootManifest, () => err(denied()));
    });

    // When the host reads, including a manifest the worker does not serve
    const owner = await host.request(resolve.owner, { label: 'doom' });
    const root = await host.request(resolve.rootManifest, { label: 'doom' });
    const executable = await host.request(resolve.executableManifest, { label: 'doom', kind: 'app' });

    // Then
    expect([owner, root, executable]).toEqual([err(syncTimeout), err(denied()), err(unsupported())]);
  });

  it('As the host, a subscription the worker interrupts reaches me through the iframe with the same variant and reason', async () => {
    // Given a worker that ends a name read typed, a chain with its handler's failure, and its telemetry as malformed
    const apiStopped: CallError<RemoteFailure> = domain({ tag: 'apiStopped', value: 'The light client stopped' });
    const { host } = linkHops(worker => {
      worker.handleSubscription(resolve.dotName, (_start, _context, sink) => {
        sink.interrupt(err(apiStopped));
        return () => undefined;
      });
      worker.handleSubscription(chain.connect, (_start, _context, sink) => {
        sink.send({ tag: 'connected', value: undefined });
        sink.interrupt(err(hostFailure('TypeError: the chain broke')));
        return () => undefined;
      });
      worker.handleSubscription(frame.telemetry, (_start, _context, sink) => {
        sink.interrupt(err(malformedFrame('a value past the limits')));
        return () => undefined;
      });
    });

    // When
    const name = record(host, resolve.dotName, { label: 'doom' });
    const connected = record(host, chain.connect, { genesisHash: '0xaa', connectionId: 'c1' });
    const telemetry = record(host, frame.telemetry, undefined);

    // Then each end is the worker's, variant and reason alike
    expect(await name.ended).toEqual(err(apiStopped));
    expect(await connected.ended).toEqual(err(hostFailure('TypeError: the chain broke')));
    expect(connected.events).toEqual([{ tag: 'connected', value: undefined }]);
    expect(await telemetry.ended).toEqual(err(malformedFrame('a value past the limits')));
  });

  it('As the host, I hear my frame failed when the worker released my port', async () => {
    // Given a host that heard its frame is ready, on an iframe whose status subscription the worker holds
    const { host, worker, workerStatus, workerStatusHeard } = linkHops(() => undefined);
    const status = record(host, frame.status, undefined);
    await Promise.all([status.until(1), workerStatusHeard]);

    // When the worker releases the iframe's port, ending its status first as the worker does
    const release = new ProtocolPortReleasedError('The worker released this tab');
    workerStatus.fail(release);
    worker.dispose(release);

    // Then the host's frame status ends with the release, typed
    await expect(status.ended).resolves.toEqual(
      err(domain({ tag: 'released', value: 'The worker released this tab' })),
    );
  });

  it('As the host, my frame status ends cleanly when the worker ends its own cleanly', async () => {
    // Given a host that heard its frame is ready
    const { host, workerStatus, workerStatusHeard } = linkHops(() => undefined);
    const status = record(host, frame.status, undefined);
    await Promise.all([status.until(1), workerStatusHeard]);

    // When
    workerStatus.interrupt(ok());

    // Then
    await expect(status.ended).resolves.toEqual(ok());
  });

  it('As the host, a call the worker holds when it releases my port fails with the release', async () => {
    // Given a worker that holds an owner read
    const asked = deferred<undefined>();
    const { host, worker, workerStatus, workerStatusHeard } = linkHops(served => {
      served.handleRequest(resolve.owner, () => {
        asked.resolve(undefined);
        return new Promise<never>(() => undefined);
      });
    });
    const owner = host.request(resolve.owner, { label: 'doom' });
    await Promise.all([asked.promise, workerStatusHeard]);

    // When the worker releases the iframe's port
    const release = new ProtocolPortReleasedError('The worker released this tab');
    workerStatus.fail(release);
    worker.dispose(release);

    // Then the host's call fails with the release instead of waiting for good
    await expect(owner).resolves.toEqual(err(hostFailure('ProtocolPortReleasedError: The worker released this tab')));
  });

  it('As the host, a chain the worker holds when it releases my port ends with the release, though the worker posts nothing as it closes', async () => {
    // Given a chain the worker holds for the host
    const { host, worker, workerStatus, workerStatusHeard } = linkHops(served => {
      served.handleSubscription(chain.connect, (_start, _context, sink) => {
        sink.send({ tag: 'connected', value: undefined });
        return () => undefined;
      });
    });
    const connected = record(host, chain.connect, { genesisHash: '0xaa', connectionId: 'c1' });
    await Promise.all([connected.until(1), workerStatusHeard]);

    // When the worker releases the iframe's port, ending its status first as the worker does
    const release = new ProtocolPortReleasedError('The worker released this tab');
    workerStatus.fail(release);
    worker.dispose(release);

    // Then the host's chain ends with the release, which the iframe's link ends it with on the status end
    await expect(connected.ended).resolves.toEqual(
      err(hostFailure('ProtocolPortReleasedError: The worker released this tab')),
    );
  });

  it("As the host, my frame fails as a version mismatch when the link meets a worker of another version, as it would for my iframe's", async () => {
    // Given a ready frame whose worker holds an owner read
    const asked = deferred<undefined>();
    const { host, link, workerStatusHeard } = linkHops(served => {
      served.handleRequest(resolve.owner, () => {
        asked.resolve(undefined);
        return new Promise<never>(() => undefined);
      });
    });
    const status = record(host, frame.status, undefined);
    const owner = host.request(resolve.owner, { label: 'doom' });
    await Promise.all([status.until(1), asked.promise, workerStatusHeard]);

    // When the link closes on a version mismatch, as its handshake with a worker of another release does
    const mismatch = new TransportUnsupportedProtocolVersionError({ wire: 1, schema: 3 }, { wire: 1, schema: 9 });
    link.dispose(mismatch);

    // Then the frame status ends typed, the host reads it as the protocol's mismatch, and the held call fails with the
    // link's closing error
    const ended = await status.ended;
    const failure: CallError<FrameFailure> = domain({ tag: 'versionMismatch', value: mismatch.message });
    expect(ended).toEqual(err(failure));
    expect(failureOf(frame.status, failure)).toBeInstanceOf(ProtocolVersionMismatchError);
    await expect(owner).resolves.toEqual(
      err(hostFailure(`TransportUnsupportedProtocolVersionError: ${mismatch.message}`)),
    );
  });

  it('As the host, my frame fails with why when the link to the worker closes, and a call the worker held fails with it', async () => {
    // Given a ready frame whose worker holds an owner read
    const asked = deferred<undefined>();
    const { host, link, workerStatusHeard } = linkHops(served => {
      served.handleRequest(resolve.owner, () => {
        asked.resolve(undefined);
        return new Promise<never>(() => undefined);
      });
    });
    const status = record(host, frame.status, undefined);
    const owner = host.request(resolve.owner, { label: 'doom' });
    await Promise.all([status.until(1), asked.promise, workerStatusHeard]);

    // When the link closes under the relay, as a ready wait that fails closes it
    link.dispose(new ProtocolInitFailedError('SharedWorker did not signal ready within timeout'));

    // Then the frame status ends as a failed init, and the held call fails with the closing error
    await expect(status.ended).resolves.toEqual(
      err(domain({ tag: 'initFailed', value: 'SharedWorker did not signal ready within timeout' })),
    );
    await expect(owner).resolves.toEqual(
      err(hostFailure('ProtocolInitFailedError: SharedWorker did not signal ready within timeout')),
    );
  });

  it("As the host, I subscribe through the iframe to calls the worker fails and hear the worker's failure", async () => {
    // Given a worker whose name read throws on start, and which serves no chain
    const { host } = linkHops(worker => {
      worker.handleSubscription(resolve.dotName, () => {
        throw new TypeError('the name read broke');
      });
    });

    // When
    const name = record(host, resolve.dotName, { label: 'doom' });
    const connected = record(host, chain.connect, { genesisHash: '0xaa', connectionId: 'c1' });

    // Then each ends with the worker's failure
    expect(await name.ended).toEqual(err(hostFailure('TypeError: the name read broke')));
    expect(await connected.ended).toEqual(err(unsupported()));
  });

  it('As a tab in shared-worker mode, I hear a chain message through the iframe and every byte is the same on both links', async () => {
    // Given a worker that answers a chain with a message that opens with a byte order mark, which a text decode drops
    const message = '\uFEFF{"jsonrpc":"2.0","id":1,"result":"0xaa"}';
    const sent = toHex(chain.connect.message.enc({ tag: 'receive', value: { tag: 'message', value: message } }));
    // The story tells a forwarding relay from a decoding one only if a decode and encode changes these bytes.
    expect(toHex(chain.connect.message.enc(chain.connect.message.dec(sent)))).not.toBe(sent);
    const { host, wire } = linkHops(worker => {
      worker.handleSubscription(chain.connect, (_start, _context, sink) => {
        sink.send({ tag: 'message', value: message });
        return () => undefined;
      });
    });

    // When
    const connected = record(host, chain.connect, { genesisHash: '0xaa', connectionId: 'c1' });
    await connected.until(1);

    // Then the worker posted the one message, and the host received it as the bytes the worker posted
    const posted = chainValues(wire.worker);
    expect(posted.map(toHex)).toEqual([sent]);
    expect(chainValues(wire.host)).toEqual(posted);
  });

  it('As a tab whose worker link closes under a chain connection, I hear the frame status end first and then my connection end with HostFailure, once', async () => {
    // Given a ready frame whose worker holds a chain for the host
    const { host, link, workerStatusHeard } = linkHops(served => {
      served.handleSubscription(chain.connect, (_start, _context, sink) => {
        sink.send({ tag: 'connected', value: undefined });
        return () => undefined;
      });
    });
    const heard: HeardEnd[] = [];
    const status = record(host, frame.status, undefined);
    const connection = record(host, chain.connect, { genesisHash: '0xaa', connectionId: 'c1' });
    // Added before either ends, so each end lands in the order the host heard it.
    void status.ended.then(end => {
      heard.push({ call: 'frame.status', end });
    });
    void connection.ended.then(end => {
      heard.push({ call: 'chain.connect', end });
    });
    await Promise.all([status.until(1), connection.until(1), workerStatusHeard]);

    // When the link closes under the relay, as a page that hides for good closes it
    link.dispose(new Error(PROTOCOL_APP_ERRORS.PORT_CLOSED));
    await connection.ended;
    // The iframe answers a method it does not serve itself, after everything it posted before.
    await expect(host.request(frame.heartbeat, undefined)).resolves.toEqual(err(unsupported()));

    // Then the frame status ended once, and the chain then ended with HostFailure of the closing error
    const closed = err(hostFailure(`Error: ${PROTOCOL_APP_ERRORS.PORT_CLOSED}`));
    expect(heard).toEqual([
      { call: 'frame.status', end: closed },
      { call: 'chain.connect', end: closed },
    ]);
  });
});
