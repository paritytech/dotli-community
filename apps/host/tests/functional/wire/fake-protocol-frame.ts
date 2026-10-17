// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Stands in for the protocol iframe, so a test drives the real host and sandbox with no chain and no network. The
// fake frame's document loads this script, which answers the host through the real serving transport with the
// options its own script tag carries as JSON.

import {
  createServingTransport,
  createWindowProvider,
  ProtocolFatalError,
  ProtocolInitFailedError,
  type Answer,
  type SubscriptionSink,
} from '@dotli/protocol';

/** How the fake answers `bitswap_v1_get` for one CID. `hold-first` holds the first ask and serves every later one. */
export type BlockMode = 'serve' | 'hold' | 'hold-first' | 'fail';

/**
 * What the fake answers `resolveDotName` with. `none` is a name with no content, `error` ends the resolution with an
 * error of that name after `delayMs`, and `fatal` ends the frame's status as a crash.
 */
export type FakeResolve =
  | { kind: 'cid'; cid: string }
  | { kind: 'none' }
  | { kind: 'error'; message: string; name?: string; delayMs?: number }
  | { kind: 'fatal'; message: string };

export interface FakeProtocolOptions {
  /** Unset, a resolution is never answered. */
  resolve?: FakeResolve;
  /** Ends the frame's status as a boot that cannot start, with this message, so the frame is never ready. */
  initFailed?: string;
  /** Hex of each block the fake can serve, by CID. */
  blocks?: Record<string, string>;
  /** Per CID. A CID with no mode is served. */
  modes?: Record<string, BlockMode>;
  /** What `resolveRootManifest` answers. None published by default. */
  rootManifest?: Answer<'resolveRootManifest'>;
}

/** What a test reads and steers in the fake, through `window.__fakeProtocol` in the protocol frame. */
export interface FakeProtocolControl {
  /** `bitswap_v1_get` asks per CID, counted as they arrive. */
  gets: Record<string, number>;
  setMode: (cid: string, mode: BlockMode) => void;
  /** Answers every held ask for `cid` and serves the later ones. */
  release: (cid: string) => void;
}

function runFakeProtocol(options: FakeProtocolOptions): void {
  const blocks = options.blocks ?? {};
  const modes: Record<string, BlockMode> = { ...options.modes };
  const gets: Record<string, number> = {};
  const held: { cid: string; connectionId: string; rpcId: unknown }[] = [];
  const connections = new Map<string, SubscriptionSink<'chainConnect'>>();
  const statuses = new Set<SubscriptionSink<'frameStatus'>>();
  const stopNothing = (): void => undefined;

  const reply = (connectionId: string, message: unknown): void => {
    connections.get(connectionId)?.send({ tag: 'message', value: JSON.stringify(message) });
  };
  const answerBlock = (connectionId: string, rpcId: unknown, cid: string): void => {
    const hex = blocks[cid];
    reply(
      connectionId,
      hex === undefined
        ? { jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: `no block ${cid}` } }
        : { jsonrpc: '2.0', id: rpcId, result: `0x${hex}` },
    );
  };
  const failBlock = (connectionId: string, rpcId: unknown, cid: string): void => {
    reply(connectionId, { jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: `e2e: ${cid} refused` } });
  };
  const askBlock = (connectionId: string, text: string): void => {
    const rpc = JSON.parse(text) as { id?: unknown; method?: string; params?: string[] };
    const cid = rpc.params?.[0];
    if (rpc.method !== 'bitswap_v1_get' || cid === undefined) {
      return;
    }
    gets[cid] = (gets[cid] ?? 0) + 1;
    const mode = modes[cid] ?? 'serve';
    if (mode === 'fail') {
      failBlock(connectionId, rpc.id, cid);
    } else if (mode === 'hold' || (mode === 'hold-first' && gets[cid] === 1)) {
      held.push({ cid, connectionId, rpcId: rpc.id });
    } else {
      answerBlock(connectionId, rpc.id, cid);
    }
  };
  const control: FakeProtocolControl = {
    gets,
    setMode(cid, mode) {
      modes[cid] = mode;
    },
    release(cid) {
      modes[cid] = 'serve';
      for (const ask of held.filter(entry => entry.cid === cid)) {
        held.splice(held.indexOf(ask), 1);
        answerBlock(ask.connectionId, ask.rpcId, cid);
      }
    },
  };
  Object.defineProperty(window, '__fakeProtocol', { value: control });

  const serving = createServingTransport(
    createWindowProvider({ listen: window, peer: () => window.parent, origin: () => true }),
    { side: 'frame', count: () => undefined },
  );

  serving.handleSubscription('frameStatus', (_payload, _context, sink) => {
    if (options.initFailed !== undefined) {
      sink.end(new ProtocolInitFailedError(options.initFailed));
      return stopNothing;
    }
    sink.send(undefined);
    statuses.add(sink);
    return () => {
      statuses.delete(sink);
    };
  });
  // The fake has no light client to report on and no other tab signing in.
  serving.handleSubscription('telemetry', () => stopNothing);
  serving.handleSubscription('sharedAuthChanges', () => stopNothing);

  serving.handleSubscription('resolveDotName', (_payload, _context, sink) => {
    const resolve = options.resolve;
    if (resolve === undefined) {
      return stopNothing;
    }
    switch (resolve.kind) {
      case 'cid':
      case 'none':
        sink.send({ tag: 'resolved', value: resolve.kind === 'cid' ? resolve.cid : null });
        sink.end();
        return stopNothing;
      case 'fatal':
        for (const status of [...statuses]) {
          status.end(new ProtocolFatalError(resolve.message));
        }
        return stopNothing;
      case 'error': {
        const timer = setTimeout(() => {
          const error = new Error(resolve.message);
          if (resolve.name !== undefined) {
            error.name = resolve.name;
          }
          sink.end(error);
        }, resolve.delayMs ?? 0);
        return () => {
          clearTimeout(timer);
        };
      }
    }
  });
  serving.handleRequest('resolveRootManifest', () => options.rootManifest ?? { kind: 'empty' as const });
  serving.handleRequest('resolveExecutableManifest', () => ({ kind: 'empty' as const }));
  serving.handleRequest('localWalletRead', () => ({ tag: 'none' as const, value: undefined }));

  serving.handleSubscription('chainConnect', ({ connectionId }, _context, sink) => {
    connections.set(connectionId, sink);
    sink.send({ tag: 'connected', value: undefined });
    return () => {
      connections.delete(connectionId);
    };
  });
  serving.handleRequest('chainSend', ({ connectionId, message }): undefined => {
    // After the send's own answer, as a light client's reply comes.
    setTimeout(() => {
      askBlock(connectionId, message);
    }, 0);
  });

  // Storage reads and the owner lookup find nothing, and writes and the warmup succeed.
  for (const method of ['resolveOwner', 'authStorageRead', 'modeStorageRead'] as const) {
    serving.handleRequest(method, () => null);
  }
  for (const method of [
    'warmup',
    'authStorageWrite',
    'authStorageClear',
    'modeStorageWrite',
    'modeStorageClear',
    'localWalletSave',
    'localWalletIdentity',
    'localWalletForget',
  ] as const) {
    serving.handleRequest(method, () => undefined);
  }
}

// Read while the script runs, the only time its own tag is `currentScript`.
const options = document.currentScript?.dataset['options'];
if (options === undefined) {
  throw new Error('the fake protocol frame script carries no options');
}
runFakeProtocol(JSON.parse(options) as FakeProtocolOptions);
