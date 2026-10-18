// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host speaks to the iframe and the iframe to a fake worker, each over a real port pair, so every call crosses both
// hops on the wire.

import { afterEach, describe, expect, it } from 'vitest';
import {
  protocolSchema,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  type ProtocolContext,
  type ProtocolSchema,
  type ProtocolTransport,
} from '@dotli/protocol';
import { deferred } from '@dotli/shared/testing';
import {
  createPortProvider,
  createTransport,
  denied,
  domain,
  err,
  hostFailure,
  malformedFrame,
  ok,
  unsupported,
  type MethodTypes,
} from '@dotli/transport';
import { createFrameStatus, type FrameStatus } from './frame-status.js';
import { watchWorkerStatus } from './shared-worker-link.js';
import { closeHostLinks, linkHost, record, type HostLink } from './testing/host-link.js';
import { registerWorkerRelay, relayTelemetry } from './worker-relay.js';

type ExecutableAnswer = Extract<MethodTypes<ProtocolSchema, 'resolve', 'executableManifest'>['response'], { ok: true }>;
type RootAnswer = Extract<MethodTypes<ProtocolSchema, 'resolve', 'rootManifest'>['response'], { ok: true }>;

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
}

const closers = new Set<() => void>();

afterEach(() => {
  for (const close of closers) {
    close();
  }
  closers.clear();
  closeHostLinks();
});

/** Links a host to an iframe in shared-worker mode, whose worker answers with what `serveWorker` registers. */
function linkHops(serveWorker: (worker: ProtocolTransport, contexts: Map<string, ProtocolContext>) => void): Hops {
  const frame: HostLink = linkHost();
  const channel = new MessageChannel();
  const worker = createTransport(protocolSchema, createPortProvider(channel.port1), {
    handshake: 'accept',
    hello: { resolutionId: null },
    onIssue: frame.report,
  });
  const toWorker = createTransport(protocolSchema, createPortProvider(channel.port2), {
    handshake: 'open',
    hello: { resolutionId: null },
    onIssue: frame.report,
  });
  toWorker.connect();
  closers.add(() => {
    const over = new Error('The spec is over');
    toWorker.dispose(over);
    worker.dispose(over);
  });
  const contexts = new Map<string, ProtocolContext>();
  serveWorker(worker, contexts);
  const workerStatus = createFrameStatus();
  const heard = deferred<undefined>();
  worker.handleSubscription('frame', 'status', (start, context, sink) => {
    const stop = workerStatus.handler(start, context, sink);
    heard.resolve(undefined);
    return stop;
  });
  workerStatus.ready();
  const status = createFrameStatus();
  frame.serving.handleSubscription('frame', 'status', status.handler);
  frame.serving.handleSubscription('frame', 'telemetry', relayTelemetry(toWorker));
  // The iframe's link holds the one status subscription to the worker and shares it with the relay.
  registerWorkerRelay(
    frame.serving,
    toWorker,
    watchWorkerStatus(toWorker, () => undefined),
    status,
  );
  status.ready();
  return {
    host: frame.host,
    worker,
    link: toWorker,
    workerStatus,
    contexts,
    workerStatusHeard: heard.promise.then(() => undefined),
  };
}

/** The worker's link context, which carries nothing of the host's call. */
const LINK_CONTEXT = { origin: null, hello: { resolutionId: null } };

describe('the worker relay', () => {
  it('As the host in shared-worker mode, my chain and resolve calls reach the worker and its answers reach me', async () => {
    // Given a worker that serves a chain, names and telemetry
    const sent: string[] = [];
    const { host, contexts } = linkHops((worker, seen) => {
      worker.handleSubscription('chain', 'connect', (_start, context, sink) => {
        seen.set('chain.connect', context);
        sink.receive({ tag: 'connected', value: undefined });
        return () => undefined;
      });
      worker.handleRequest('chain', 'send', ({ message }) => {
        sent.push(message);
        return ok();
      });
      worker.handleRequest('resolve', 'owner', ({ label }, context) => {
        seen.set('resolve.owner', context);
        return ok(label === 'doom' ? '0xowner' : null);
      });
      worker.handleRequest('frame', 'warmup', () => ok());
      worker.handleSubscription('resolve', 'dotName', (_start, _context, sink) => {
        sink.receive({ tag: 'phase', value: 'resolving-content' });
        sink.receive({ tag: 'resolved', value: 'bafycid' });
        sink.interrupt();
        return () => undefined;
      });
      worker.handleSubscription('frame', 'telemetry', (_start, _context, sink) => {
        sink.receive({ tag: 'netBytes', value: 4_000 });
        return () => undefined;
      });
    });

    // When the host connects a chain, sends on it, resolves a name and its owner, and hears telemetry
    const chain = record(host, 'chain', 'connect', { genesisHash: '0xaa', connectionId: 'c1' });
    await chain.until(1);
    const sentAnswer = await host.request('chain', 'send', { connectionId: 'c1', message: '{"jsonrpc":"2.0"}' });
    const owner = await host.request('resolve', 'owner', { label: 'doom' });
    const warmed = await host.request('frame', 'warmup', undefined);
    const name = record(host, 'resolve', 'dotName', { label: 'doom' });
    const telemetry = record(host, 'frame', 'telemetry', undefined);
    await telemetry.until(1);

    // Then the worker's answers, values and ends reached the host, and the worker heard nothing of the host's call
    expect(chain.events).toEqual([{ tag: 'connected', value: undefined }]);
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
    const asked: unknown[] = [];
    const { host, contexts } = linkHops((served, seen) => {
      served.handleRequest('resolve', 'executableManifest', (payload, context) => {
        asked.push(payload);
        seen.set('resolve.executableManifest', context);
        return ok(executableAnswer);
      });
      served.handleRequest('resolve', 'rootManifest', (payload, context) => {
        asked.push(payload);
        seen.set('resolve.rootManifest', context);
        return ok(rootAnswer);
      });
    });

    // When
    const executable = await host.request('resolve', 'executableManifest', { label: 'doom', kind: 'worker' });
    const root = await host.request('resolve', 'rootManifest', { label: 'doom' });

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
    const disconnected = new Promise<void>(resolve => {
      stopped = resolve;
    });
    const { host } = linkHops(worker => {
      worker.handleSubscription('chain', 'connect', (_start, _context, sink) => {
        sink.receive({ tag: 'connected', value: undefined });
        return stopped;
      });
    });
    const chain = record(host, 'chain', 'connect', { genesisHash: '0xaa', connectionId: 'c1' });
    await chain.until(1);

    // When the host disconnects
    chain.unsubscribe();

    // Then the worker stops the chain
    await disconnected;
  });

  it("As a dotli maintainer, a call the worker fails reaches the host under the worker's error name", async () => {
    // Given a worker whose owner read fails
    const { host } = linkHops(worker => {
      worker.handleRequest('resolve', 'owner', () => {
        throw new TypeError('storage read failed');
      });
    });

    // When the host asks for an owner
    const owner = await host.request('resolve', 'owner', { label: 'doom' });

    // Then the host hears the worker's failure as the worker answered it
    expect(owner).toEqual(err(hostFailure('TypeError: storage read failed')));
  });

  it('As the host, a request the worker answers with a failure reaches me through the iframe unchanged', async () => {
    // Given a worker whose reads fail in each way a handler can answer
    const syncTimeout = domain({ tag: 'syncTimeout' as const, value: 'Asset Hub did not sync' });
    const { host } = linkHops(worker => {
      worker.handleRequest('resolve', 'owner', () => err(syncTimeout));
      worker.handleRequest('resolve', 'rootManifest', () => err(denied()));
    });

    // When the host reads, including a manifest the worker does not serve
    const owner = await host.request('resolve', 'owner', { label: 'doom' });
    const root = await host.request('resolve', 'rootManifest', { label: 'doom' });
    const executable = await host.request('resolve', 'executableManifest', { label: 'doom', kind: 'app' });

    // Then
    expect([owner, root, executable]).toEqual([err(syncTimeout), err(denied()), err(unsupported())]);
  });

  it('As the host, a subscription the worker interrupts reaches me through the iframe with the same variant and reason', async () => {
    // Given a worker that ends a name read typed, a chain with its handler's failure, and its telemetry as malformed
    const apiStopped = domain({ tag: 'apiStopped' as const, value: 'The light client stopped' });
    const { host } = linkHops(worker => {
      worker.handleSubscription('resolve', 'dotName', (_start, _context, sink) => {
        sink.interrupt(apiStopped);
        return () => undefined;
      });
      worker.handleSubscription('chain', 'connect', (_start, _context, sink) => {
        sink.receive({ tag: 'connected', value: undefined });
        sink.interrupt(hostFailure('TypeError: the chain broke'));
        return () => undefined;
      });
      worker.handleSubscription('frame', 'telemetry', (_start, _context, sink) => {
        sink.interrupt(malformedFrame('a value past the limits'));
        return () => undefined;
      });
    });

    // When
    const name = record(host, 'resolve', 'dotName', { label: 'doom' });
    const chain = record(host, 'chain', 'connect', { genesisHash: '0xaa', connectionId: 'c1' });
    const telemetry = record(host, 'frame', 'telemetry', undefined);

    // Then each end is the worker's, variant and reason alike
    expect(await name.ended).toEqual(err(apiStopped));
    expect(await chain.ended).toEqual(err(hostFailure('TypeError: the chain broke')));
    expect(chain.events).toEqual([{ tag: 'connected', value: undefined }]);
    expect(await telemetry.ended).toEqual(err(malformedFrame('a value past the limits')));
  });

  it('As the host, I hear my frame failed when the worker released my port', async () => {
    // Given a host that heard its frame is ready, on an iframe whose status subscription the worker holds
    const { host, worker, workerStatus, workerStatusHeard } = linkHops(() => undefined);
    const status = record(host, 'frame', 'status', undefined);
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
    const status = record(host, 'frame', 'status', undefined);
    await Promise.all([status.until(1), workerStatusHeard]);

    // When
    workerStatus.interrupt();

    // Then
    await expect(status.ended).resolves.toEqual(ok());
  });

  it('As the host, a call the worker holds when it releases my port fails with the release', async () => {
    // Given a worker that holds an owner read
    const asked = deferred<undefined>();
    const { host, worker, workerStatus, workerStatusHeard } = linkHops(served => {
      served.handleRequest('resolve', 'owner', () => {
        asked.resolve(undefined);
        return new Promise<never>(() => undefined);
      });
    });
    const owner = host.request('resolve', 'owner', { label: 'doom' });
    await Promise.all([asked.promise, workerStatusHeard]);

    // When the worker releases the iframe's port
    const release = new ProtocolPortReleasedError('The worker released this tab');
    workerStatus.fail(release);
    worker.dispose(release);

    // Then the host's call fails with the release instead of waiting for good
    await expect(owner).resolves.toEqual(err(hostFailure('ProtocolPortReleasedError: The worker released this tab')));
  });

  it('As the host, my frame fails with why when the link to the worker closes, and a call the worker held fails with it', async () => {
    // Given a ready frame whose worker holds an owner read
    const asked = deferred<undefined>();
    const { host, link, workerStatusHeard } = linkHops(served => {
      served.handleRequest('resolve', 'owner', () => {
        asked.resolve(undefined);
        return new Promise<never>(() => undefined);
      });
    });
    const status = record(host, 'frame', 'status', undefined);
    const owner = host.request('resolve', 'owner', { label: 'doom' });
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
});
