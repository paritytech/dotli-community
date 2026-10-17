// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Stands in for the protocol iframe, so a test drives the real host and sandbox with no chain and no network. The
// fake runs in the frame's own origin and answers the host through the real serving transport, which the wire bundle
// gives it.

import { readFile } from 'node:fs/promises';
import { expect, type Frame, type Page } from '@playwright/test';
import type { Answer, SubscriptionSink } from '@dotli/protocol';
import { PORT } from '../../env.js';
import { WIRE_BUNDLE_PATH } from '../global-setup.js';
import type * as Wire from '../wire/protocol-wire.js';

const PROTOCOL_HOST = `host.localhost:${PORT}`;

/**
 * Serves `script` as the protocol iframe's document, after the wire bundle that gives it the global `dotliWire`.
 * Registered on the page, so every rebuild of the frame gets it.
 */
export async function mockProtocolIframe(page: Page, script: string): Promise<void> {
  const wire = await readFile(WIRE_BUNDLE_PATH, 'utf8');
  // The HTML parser ends a script at this text wherever it stands, even inside a string.
  if (/<\/script/i.test(wire)) {
    throw new Error(`${WIRE_BUNDLE_PATH} holds "</script", which would end its inline tag early`);
  }
  await page.route('**', async route => {
    const isProtocolDoc =
      route.request().url().includes(PROTOCOL_HOST) && route.request().resourceType() === 'document';
    if (!isProtocolDoc) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><body><script>${wire}</script><script>${script}</script></body></html>`,
    });
  });
}

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

// Serialized into the frame, so it uses nothing from its module scope but types, and reaches the wire through the
// bundle's global.
function runFakeProtocol(options: FakeProtocolOptions): void {
  const wire = (window as unknown as { dotliWire: typeof Wire }).dotliWire;
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

  const serving = wire.createServingTransport(
    wire.createWindowProvider({ listen: window, peer: () => window.parent, origin: () => true }),
    { side: 'frame', count: () => undefined },
  );

  serving.handleSubscription('frameStatus', (_payload, _context, sink) => {
    if (options.initFailed !== undefined) {
      sink.end(new wire.ProtocolInitFailedError(options.initFailed));
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
          status.end(new wire.ProtocolFatalError(resolve.message));
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

/** The fake frame's script for `options`, for `mockProtocolIframe`. */
function fakeScript(options: FakeProtocolOptions): string {
  return `(${runFakeProtocol.toString()})(${JSON.stringify(options)});`;
}

/** Serves the fake protocol frame for every protocol frame the page builds. */
export async function fakeProtocol(page: Page, options: FakeProtocolOptions): Promise<void> {
  await mockProtocolIframe(page, fakeScript(options));
}

/** A frame whose boot cannot start. */
export const initFailed = (message: string): string => fakeScript({ initFailed: message });

/** A frame whose light client crashes once a name is asked for. */
export const fatalOnResolve = (message: string): string => fakeScript({ resolve: { kind: 'fatal', message } });

export const errorResolveResponse = (message: string, delayMs = 0, name?: string): string =>
  fakeScript({
    resolve: name === undefined ? { kind: 'error', message, delayMs } : { kind: 'error', message, delayMs, name },
  });

export const nullResolveResponse = fakeScript({ resolve: { kind: 'none' } });

export const successfulResolveResponse = (cid: string): string => fakeScript({ resolve: { kind: 'cid', cid } });

/** The protocol frame the page has now, waited for. */
async function protocolFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some(frame => frame.url().includes(PROTOCOL_HOST))).toBe(true);
  const frame = page.frames().find(candidate => candidate.url().includes(PROTOCOL_HOST));
  if (frame === undefined) {
    throw new Error('the protocol frame went away');
  }
  return frame;
}

/** `bitswap_v1_get` asks the fake has had for `cid`. */
export async function blockGets(page: Page, cid: string): Promise<number> {
  const frame = await protocolFrame(page);
  return frame.evaluate(
    target => (window as unknown as { __fakeProtocol: FakeProtocolControl }).__fakeProtocol.gets[target] ?? 0,
    cid,
  );
}

export async function setBlockMode(page: Page, cid: string, mode: BlockMode): Promise<void> {
  const frame = await protocolFrame(page);
  await frame.evaluate(
    ([target, next]) => {
      (window as unknown as { __fakeProtocol: FakeProtocolControl }).__fakeProtocol.setMode(target, next);
    },
    [cid, mode] as const,
  );
}

export async function releaseBlock(page: Page, cid: string): Promise<void> {
  const frame = await protocolFrame(page);
  await frame.evaluate(target => {
    (window as unknown as { __fakeProtocol: FakeProtocolControl }).__fakeProtocol.release(target);
  }, cid);
}
