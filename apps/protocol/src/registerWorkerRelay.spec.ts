// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host speaks to the iframe and the iframe to a fake worker, each over its own link, so every call crosses both
// hops on the wire.

import { afterEach, describe, expect, it } from 'vitest';
import {
  getFailure,
  protocolSchema,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolVersionMismatchError,
  type FrameFailure,
  type ProtocolContext,
  type ProtocolTransport,
  type RemoteFailure,
  createFrameStatus,
} from '@dotli/protocol';
import { createDeferred, toHex } from '@dotli/shared';
import { catchError } from '@dotli/shared/testing';
import {
  TransportUnsupportedProtocolVersionError,
  denied,
  domain,
  err,
  hostFailure,
  malformedFrame,
  ok,
  unsupported,
  type CallError,
  type MethodTypes,
} from '@dotli/transport';
import { readFrame } from '@dotli/transport/testing';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { registerWorkerRelay } from './registerWorkerRelay.js';
import { closeHostLinks, linkHost, type HostLink } from './testing/linkHost.js';
import { record, type EndOf } from './testing/record.js';
import { serveWorkerStatus } from './testing/serveWorkerStatus.js';
import { watchWorkerStatus } from './watchWorkerStatus.js';

const { frame, resolve, chain } = protocolSchema.sections;

type Executable = MethodTypes<typeof resolve.executableManifest>;
type Root = MethodTypes<typeof resolve.rootManifest>;
type ExecutableAnswer = Extract<Executable['response'], { success: true }>;
type RootAnswer = Extract<Root['response'], { success: true }>;

afterEach(() => {
  closeHostLinks();
});

/** Links a host to an iframe in shared-worker mode, whose worker answers with what `serveWorker` registers. */
function linkHops(serveWorker: (worker: ProtocolTransport, contexts: Map<string, ProtocolContext>) => void) {
  const iframe: HostLink = linkHost();
  const { serving: worker, host: toWorker, delivered } = linkHost();
  const contexts = new Map<string, ProtocolContext>();
  serveWorker(worker, contexts);
  const { workerStatus, subscribed } = serveWorkerStatus(worker);
  workerStatus.markReady();
  const status = createFrameStatus();
  iframe.serving.handleSubscription(frame.status, status.handler);
  // The iframe's link holds the one status subscription to the worker and shares it with the relay.
  const watched = watchWorkerStatus({ transport: toWorker, onReady: () => undefined });
  const bootEnds: string[] = [];
  const stop = registerWorkerRelay({
    serving: iframe.serving,
    worker: toWorker,
    workerStatus: watched,
    boot: {
      ...status,
      fail(error) {
        bootEnds.push('fail');
        status.fail(error);
      },
      interrupt(outcome) {
        bootEnds.push('interrupt');
        status.interrupt(outcome);
      },
      serveTelemetry: source => {
        iframe.serving.handleSubscription(frame.telemetry, source);
      },
    },
  });
  status.markReady();
  return {
    /** The host page's end toward the iframe. */
    host: iframe.host,
    /** The worker's end, where a spec registers what the worker answers. */
    worker,
    /** The iframe's end toward the worker, which the relay calls through. */
    link: toWorker,
    /** The worker's own status, which every subscription of the iframe's hears. */
    workerStatus,
    /** The iframe's one subscription to that status, which a case listens to after the relay. */
    watched,
    /** What stops the relay. */
    stop,
    /** Which end the relay handed the frame's boot, in order. */
    bootEnds,
    /** Each call context the worker saw, by method. */
    contexts,
    /** Settles once the iframe's status subscription reached the worker, which reports itself ready. */
    workerStatusHeard: subscribed,
    /** The frames delivered on the host's link to the iframe, and on the iframe's link to the worker. */
    wire: { host: iframe.delivered, worker: delivered },
  };
}

/** The worker's link context, which carries nothing of the host's call. */
const LINK_CONTEXT = { hello: { resolutionId: null } };

/** The message bytes of each chain value among `frames`. */
function readChainValues(frames: readonly Uint8Array[]): Uint8Array[] {
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
type HeardEnd = {
  call: string;
  end: EndOf<unknown>;
};

describe('the worker relay', () => {
  it('As the host in shared-worker mode, I call chain and resolve methods and the worker answers me through the iframe', async () => {
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
    const connected = record({
      transport: host,
      method: chain.connect,
      start: { genesisHash: '0xaa', connectionId: 'c1' },
    });
    await connected.waitFor(1);
    const sentAnswer = await host.request(chain.send, { connectionId: 'c1', message: '{"jsonrpc":"2.0"}' });
    const owner = await host.request(resolve.owner, { label: 'doom' });
    const warmed = await host.request(frame.warmup, undefined);
    const name = record({ transport: host, method: resolve.dotName, start: { label: 'doom' } });
    const telemetry = record({ transport: host, method: frame.telemetry, start: undefined });
    await telemetry.waitFor(1);

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

  it('As the host in shared-worker mode, I read manifests and the worker answers me through the iframe', async () => {
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

  it('As the host, I disconnect and the worker stops the chain', async () => {
    // Given a chain the worker holds for the host
    const disconnected = createDeferred<undefined>();
    const { host } = linkHops(worker => {
      worker.handleSubscription(chain.connect, (_start, _context, sink) => {
        sink.send({ tag: 'connected', value: undefined });
        return () => {
          disconnected.resolve(undefined);
        };
      });
    });
    const connected = record({
      transport: host,
      method: chain.connect,
      start: { genesisHash: '0xaa', connectionId: 'c1' },
    });
    await connected.waitFor(1);

    // When the host disconnects
    connected.unsubscribe();

    // Then the worker stops the chain
    await expect(disconnected.promise).resolves.toBeUndefined();
  });

  it("As a dotli maintainer, I watch the worker fail a call and the host hears it under the worker's error name", async () => {
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

  it('As the host, I make requests the worker answers with failures and hear them through the iframe unchanged', async () => {
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

  it('As the host, I subscribe to calls the worker interrupts and hear each end through the iframe with the same variant and reason', async () => {
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
    const name = record({ transport: host, method: resolve.dotName, start: { label: 'doom' } });
    const connected = record({
      transport: host,
      method: chain.connect,
      start: { genesisHash: '0xaa', connectionId: 'c1' },
    });
    const telemetry = record({ transport: host, method: frame.telemetry, start: undefined });

    // Then each end is the worker's, variant and reason alike
    expect(await name.ended).toEqual(err(apiStopped));
    expect(await connected.ended).toEqual(err(hostFailure('TypeError: the chain broke')));
    expect(connected.events).toEqual([{ tag: 'connected', value: undefined }]);
    expect(await telemetry.ended).toEqual(err(malformedFrame('a value past the limits')));
  });

  it('As the host, I watch the worker release my port and hear my frame failed', async () => {
    // Given a host that heard its frame is ready, on an iframe whose status subscription the worker holds
    const { host, worker, workerStatus, workerStatusHeard } = linkHops(() => undefined);
    const status = record({ transport: host, method: frame.status, start: undefined });
    await Promise.all([status.waitFor(1), workerStatusHeard]);

    // When the worker releases the iframe's port, ending its status first as the worker does
    const release = new ProtocolPortReleasedError('The worker released this tab');
    workerStatus.fail(release);
    worker.dispose(release);

    // Then the host's frame status ends with the release, typed
    await expect(status.ended).resolves.toEqual(
      err(domain({ tag: 'released', value: 'The worker released this tab' })),
    );
  });

  it('As the host, I watch the worker end its status cleanly and my frame status ends cleanly', async () => {
    // Given a host that heard its frame is ready
    const { host, workerStatus, workerStatusHeard } = linkHops(() => undefined);
    const status = record({ transport: host, method: frame.status, start: undefined });
    await Promise.all([status.waitFor(1), workerStatusHeard]);

    // When
    workerStatus.interrupt(ok());

    // Then
    await expect(status.ended).resolves.toEqual(ok());
  });

  it('As the host, I wait on a call the worker holds when it releases my port and the call fails with the release', async () => {
    // Given a worker that holds an owner read
    const asked = createDeferred<undefined>();
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

  it('As the host, I keep a chain open when the worker releases my port and the chain ends with the release, though the worker posts nothing as it closes', async () => {
    // Given a chain the worker holds for the host
    const { host, worker, workerStatus, workerStatusHeard } = linkHops(served => {
      served.handleSubscription(chain.connect, (_start, _context, sink) => {
        sink.send({ tag: 'connected', value: undefined });
        return () => undefined;
      });
    });
    const connected = record({
      transport: host,
      method: chain.connect,
      start: { genesisHash: '0xaa', connectionId: 'c1' },
    });
    await Promise.all([connected.waitFor(1), workerStatusHeard]);

    // When the worker releases the iframe's port, ending its status first as the worker does
    const release = new ProtocolPortReleasedError('The worker released this tab');
    workerStatus.fail(release);
    worker.dispose(release);

    // Then the host's chain ends with the release, which the iframe's link ends it with on the status end
    await expect(connected.ended).resolves.toEqual(
      err(hostFailure('ProtocolPortReleasedError: The worker released this tab')),
    );
  });

  it("As the host, I watch the link meet a worker of another version and my frame fails as a version mismatch, as it would for my iframe's", async () => {
    // Given a ready frame whose worker holds an owner read
    const asked = createDeferred<undefined>();
    const { host, link, workerStatusHeard } = linkHops(served => {
      served.handleRequest(resolve.owner, () => {
        asked.resolve(undefined);
        return new Promise<never>(() => undefined);
      });
    });
    const status = record({ transport: host, method: frame.status, start: undefined });
    const owner = host.request(resolve.owner, { label: 'doom' });
    await Promise.all([status.waitFor(1), asked.promise, workerStatusHeard]);

    // When the link closes on a version mismatch, as its handshake with a worker of another release does
    const mismatch = new TransportUnsupportedProtocolVersionError({ wire: 1, schema: 3 }, { wire: 1, schema: 9 });
    link.dispose(mismatch);

    // Then the frame status ends typed, the host reads it as the protocol's mismatch, and the held call fails with the
    // link's closing error
    const ended = await status.ended;
    const failure: CallError<FrameFailure> = domain({ tag: 'versionMismatch', value: mismatch.message });
    expect(ended).toEqual(err(failure));
    expect(getFailure(frame.status, failure)).toBeInstanceOf(ProtocolVersionMismatchError);
    await expect(owner).resolves.toEqual(
      err(hostFailure(`TransportUnsupportedProtocolVersionError: ${mismatch.message}`)),
    );
  });

  it('As the host, I watch the link to the worker close and my frame fails with why, as does a call the worker held', async () => {
    // Given a ready frame whose worker holds an owner read
    const asked = createDeferred<undefined>();
    const { host, link, workerStatusHeard } = linkHops(served => {
      served.handleRequest(resolve.owner, () => {
        asked.resolve(undefined);
        return new Promise<never>(() => undefined);
      });
    });
    const status = record({ transport: host, method: frame.status, start: undefined });
    const owner = host.request(resolve.owner, { label: 'doom' });
    await Promise.all([status.waitFor(1), asked.promise, workerStatusHeard]);

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

  it('As the host, I start subscriptions the worker refuses through the iframe and hear each refusal as the worker sent it', async () => {
    // Given a worker whose name read throws on start, and which serves no chain
    const { host } = linkHops(worker => {
      worker.handleSubscription(resolve.dotName, () => {
        throw new TypeError('the name read broke');
      });
    });

    // When
    const name = record({ transport: host, method: resolve.dotName, start: { label: 'doom' } });
    const connected = record({
      transport: host,
      method: chain.connect,
      start: { genesisHash: '0xaa', connectionId: 'c1' },
    });

    // Then each ends with the worker's failure
    expect(await name.ended).toEqual(err(hostFailure('TypeError: the name read broke')));
    expect(await connected.ended).toEqual(err(unsupported()));
  });

  it('As a tab in shared-worker mode, I hear a chain message through the iframe and every byte is the same on both links', async () => {
    // Given a worker that answers a chain with a message that opens with a byte order mark, which a text decode drops
    const message = '\uFEFF{"jsonrpc":"2.0","id":1,"result":"0xaa"}';
    const sent = toHex(chain.connect.message.enc({ tag: 'receive', value: { tag: 'message', value: message } }));
    // The story tells a forwarding relay from a decoding one only if a decode and encode changes these bytes.
    const reencoded = toHex(chain.connect.message.enc(chain.connect.message.dec(sent)));
    const { host, wire } = linkHops(worker => {
      worker.handleSubscription(chain.connect, (_start, _context, sink) => {
        sink.send({ tag: 'message', value: message });
        return () => undefined;
      });
    });

    // When
    const connected = record({
      transport: host,
      method: chain.connect,
      start: { genesisHash: '0xaa', connectionId: 'c1' },
    });
    await connected.waitFor(1);

    // Then a decode would have changed the message, the worker posted it once, and the host received the bytes it posted
    expect(reencoded).not.toBe(sent);
    const posted = readChainValues(wire.worker);
    expect(posted.map(toHex)).toEqual([sent]);
    expect(readChainValues(wire.host)).toEqual(posted);
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
    const status = record({ transport: host, method: frame.status, start: undefined });
    const connection = record({
      transport: host,
      method: chain.connect,
      start: { genesisHash: '0xaa', connectionId: 'c1' },
    });
    // Added before either ends, so each end lands in the order the host heard it.
    void status.ended.then(end => {
      heard.push({ call: 'frame.status', end });
    });
    void connection.ended.then(end => {
      heard.push({ call: 'chain.connect', end });
    });
    await Promise.all([status.waitFor(1), connection.waitFor(1), workerStatusHeard]);

    // When the link closes under the relay, as a page that hides for good closes it
    link.dispose(new Error(PROTOCOL_APP_ERRORS.PORT_CLOSED));
    await connection.ended;
    // The iframe answers a method it does not serve itself, after everything it posted before.
    await host.request(frame.heartbeat, undefined);

    // Then the frame status ended once, and the chain then ended with HostFailure of the closing error
    const closed = err(hostFailure(`Error: ${PROTOCOL_APP_ERRORS.PORT_CLOSED}`));
    expect(heard).toEqual([
      { call: 'frame.status', end: closed },
      { call: 'chain.connect', end: closed },
    ]);
  });

  it('As a frame that stopped relaying, I forward no more calls to the worker and its end reaches no one', async () => {
    // Given a relay whose worker answers a name call (an owner read), and a host that heard its frame is ready
    const { host, workerStatus, watched, stop, bootEnds, workerStatusHeard } = linkHops(worker => {
      worker.handleRequest(resolve.owner, () => ok('0xowner'));
    });
    const status = record({ transport: host, method: frame.status, start: undefined });
    await Promise.all([status.waitFor(1), workerStatusHeard]);
    const forwarded = await host.request(resolve.owner, { label: 'doom' });

    // When the frame stops relaying, and the worker then ends its status
    stop();
    const refused = await host.request(resolve.owner, { label: 'doom' });
    const heard = new Promise<void>(resolve => {
      watched.onEnd(() => {
        resolve();
      });
    });
    workerStatus.fail(new ProtocolPortReleasedError('The worker released this tab'));
    await heard;

    // Then the name call was forwarded before the stop and refused as unserved after it, and the boot heard no end
    expect(forwarded).toEqual(ok('0xowner'));
    expect(refused).toEqual(err(unsupported()));
    expect(bootEnds).toEqual([]);
  });

  it('As a frame that stops relaying twice, I stop it again and nothing throws', () => {
    // Given a relay that was stopped
    const { stop } = linkHops(() => undefined);
    stop();

    // When the frame stops it again
    const thrown = catchError(stop);

    // Then nothing throws
    expect(thrown).toBeUndefined();
  });
});
