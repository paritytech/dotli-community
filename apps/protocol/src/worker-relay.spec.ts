// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host speaks to the iframe and the iframe to a fake worker, each over a real port pair, so every call crosses both
// hops on the wire.

import { afterEach, describe, expect, it } from 'vitest';
import {
  createConsumerTransport,
  createPortProvider,
  createServingTransport,
  ProtocolPortReleasedError,
  type CallContext,
  type ConsumerTransport,
  type ServingTransport,
} from '@dotli/protocol';
import { createFrameStatus } from './frame-status.js';
import { closeHostLinks, linkHost, record, type HostLink } from './testing/host-link.js';
import { registerWorkerRelay, relayTelemetry } from './worker-relay.js';

interface Hops {
  host: ConsumerTransport;
  /** The worker's end, where a spec registers what the worker answers. */
  worker: ServingTransport;
  /** Each call context the worker saw, by method. */
  contexts: Map<string, CallContext>;
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
function linkHops(serveWorker: (worker: ServingTransport, contexts: Map<string, CallContext>) => void): Hops {
  const frame: HostLink = linkHost();
  const channel = new MessageChannel();
  const worker = createServingTransport(createPortProvider(channel.port1), { side: 'worker', count: () => 0 });
  const toWorker = createConsumerTransport(createPortProvider(channel.port2), { side: 'frame', count: () => 0 });
  toWorker.connect();
  closers.add(() => {
    const over = new Error('The spec is over');
    toWorker.dispose(over);
    worker.dispose(over);
  });
  const contexts = new Map<string, CallContext>();
  serveWorker(worker, contexts);
  const status = createFrameStatus();
  frame.serving.handleSubscription('frameStatus', status.handler);
  frame.serving.handleSubscription('telemetry', relayTelemetry(toWorker));
  registerWorkerRelay(frame.serving, toWorker, status);
  status.ready();
  return { host: frame.host, worker, contexts };
}

describe('the worker relay', () => {
  it('As the host in shared-worker mode, my chain and resolve calls reach the worker and its answers reach me', async () => {
    // Given a worker that serves a chain, names and telemetry
    const deadlineMs = Date.now() + 60_000;
    const sent: string[] = [];
    const { host, contexts } = linkHops((worker, seen) => {
      worker.handleSubscription('chainConnect', (_payload, context, sink) => {
        seen.set('chainConnect', context);
        sink.send({ tag: 'connected', value: undefined });
        return () => undefined;
      });
      worker.handleRequest('chainSend', ({ message }) => {
        sent.push(message);
        return undefined;
      });
      worker.handleRequest('resolveOwner', ({ label }, context) => {
        seen.set('resolveOwner', context);
        return label === 'doom' ? '0xowner' : null;
      });
      worker.handleRequest('warmup', () => undefined);
      worker.handleSubscription('resolveDotName', (_payload, _context, sink) => {
        sink.send({ tag: 'phase', value: 'resolving-content' });
        sink.send({ tag: 'resolved', value: 'bafycid' });
        sink.end();
        return () => undefined;
      });
      worker.handleSubscription('telemetry', (_payload, _context, sink) => {
        sink.send({ tag: 'netBytes', value: 4_000 });
        return () => undefined;
      });
    });

    // When the host connects a chain, sends on it, resolves a name and its owner, and hears telemetry
    const chain = record(host, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }, { deadlineMs });
    await chain.until(1);
    await host.request('chainSend', { connectionId: 'c1', message: '{"jsonrpc":"2.0"}' });
    const owner = await host.request('resolveOwner', { label: 'doom' }, { deadlineMs });
    await host.request('warmup', undefined);
    const name = record(host, 'resolveDotName', { label: 'doom' });
    const telemetry = record(host, 'telemetry', undefined);
    await telemetry.until(1);

    // Then the worker's answers, events and ends reached the host, and the worker read the host's deadline
    expect(chain.events).toEqual([{ tag: 'connected', value: undefined }]);
    expect(sent).toEqual(['{"jsonrpc":"2.0"}']);
    expect(owner).toBe('0xowner');
    await expect(name.ended).resolves.toBeNull();
    expect(name.events).toEqual([
      { tag: 'phase', value: 'resolving-content' },
      { tag: 'resolved', value: 'bafycid' },
    ]);
    expect(telemetry.events).toEqual([{ tag: 'netBytes', value: 4_000 }]);
    expect(contexts.get('chainConnect')?.deadlineMs).toBe(deadlineMs);
    expect(contexts.get('resolveOwner')?.deadlineMs).toBe(deadlineMs);
  });

  it('As the host, my disconnect reaches the worker', async () => {
    // Given a chain the worker holds for the host
    let stopped: () => void = () => undefined;
    const disconnected = new Promise<void>(resolve => {
      stopped = resolve;
    });
    const { host } = linkHops(worker => {
      worker.handleSubscription('chainConnect', (_payload, _context, sink) => {
        sink.send({ tag: 'connected', value: undefined });
        return stopped;
      });
    });
    const chain = record(host, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await chain.until(1);

    // When the host disconnects
    chain.unsubscribe();

    // Then the worker stops the chain
    await disconnected;
  });

  it('As a dotli maintainer, a call the worker fails reaches the host with where the worker threw it', async () => {
    // Given a worker whose owner read fails
    const failure = new TypeError('storage read failed');
    const { host } = linkHops(worker => {
      worker.handleRequest('resolveOwner', () => {
        throw failure;
      });
    });

    // When the host asks for an owner
    const error = await host.request('resolveOwner', { label: 'doom' }).catch((err: unknown) => err);

    // Then the host hears the worker's class, message and stack
    expect(error).toMatchObject({
      name: 'TypeError',
      message: 'storage read failed',
      remoteStack: failure.stack,
    });
  });

  it('As the host, I hear my frame failed when the worker released my port', async () => {
    // Given a host that heard its frame is ready, on an iframe whose status subscription the worker holds
    let held: () => void = () => undefined;
    const relayHeld = new Promise<void>(resolve => {
      held = resolve;
    });
    const { host, worker } = linkHops(served => {
      const workerStatus = createFrameStatus();
      served.handleSubscription('frameStatus', (payload, context, sink) => {
        const stop = workerStatus.handler(payload, context, sink);
        held();
        return stop;
      });
      workerStatus.ready();
    });
    const status = record(host, 'frameStatus', undefined);
    await Promise.all([status.until(1), relayHeld]);

    // When the worker releases the iframe's port
    worker.dispose(new ProtocolPortReleasedError('The worker released this tab'));

    // Then the host's frame status ends with the release, by its class
    await expect(status.ended).resolves.toMatchObject({
      name: 'ProtocolPortReleasedError',
      message: 'The worker released this tab',
    });
  });
});
