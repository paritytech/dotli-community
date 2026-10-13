// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Stands in for the protocol iframe, so a test drives the real host and sandbox with no chain and no network. The
// fake runs in the frame's own origin and answers the host over the same `dotli:protocol` envelopes.

import { expect, type Frame, type Page } from '@playwright/test';
import { PORT } from '../../env.js';

const PROTOCOL_HOST = `host.localhost:${PORT}`;

/** Serves `script` as the protocol iframe's document. Registered on the page, so every rebuild of the frame gets it. */
export async function mockProtocolIframe(page: Page, script: string): Promise<void> {
  await page.route('**', async route => {
    const isProtocolDoc =
      route.request().url().includes(PROTOCOL_HOST) && route.request().resourceType() === 'document';
    if (!isProtocolDoc) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><body><script>${script}</script></body></html>`,
    });
  });
}

const READY = `window.parent.postMessage({namespace:"dotli:protocol",kind:"ready"},"*");`;

// Retried until the parent blanks the iframe, since a single post can land before any waiter is queued.
export const initFailed = (message: string): string => `
  window.addEventListener("load", function() {
    var msg = {
      namespace: "dotli:protocol",
      kind: "init-failed",
      message: ${JSON.stringify(message)},
    };
    var delay = 20;
    var attempts = 0;
    function post() {
      if (attempts++ >= 12) return;
      try { window.parent.postMessage(msg, "*"); } catch (e) { return; }
      delay = Math.min(delay * 2, 500);
      setTimeout(post, delay);
    }
    post();
  });
`;

export const fatalOnResolve = (message: string): string => `
  ${READY}
  window.addEventListener("message", function(e) {
    if (e.data && e.data.namespace === "dotli:protocol" && e.data.method === "resolveDotName") {
      window.parent.postMessage({
        namespace: "dotli:protocol",
        kind: "fatal",
        message: ${JSON.stringify(message)},
      }, "*");
    }
  });
`;

export const errorResolveResponse = (error: string, delayMs = 0, errorName?: string): string => `
  ${READY}
  window.addEventListener("message", function(e) {
    if (e.data && e.data.namespace === "dotli:protocol" && e.data.method === "resolveDotName") {
      var id = e.data.id;
      setTimeout(function() {
        window.parent.postMessage({
          namespace: "dotli:protocol",
          kind: "response",
          id: id,
          ok: false,
          error: ${JSON.stringify(error)},
          errorName: ${errorName === undefined ? 'undefined' : JSON.stringify(errorName)},
        }, "*");
      }, ${String(delayMs)});
    }
  });
`;

export const nullResolveResponse = `
  ${READY}
  window.addEventListener("message", function(e) {
    if (e.data && e.data.namespace === "dotli:protocol" && e.data.method === "resolveDotName") {
      window.parent.postMessage({
        namespace: "dotli:protocol",
        kind: "response",
        id: e.data.id,
        ok: true,
        result: null,
      }, "*");
    }
  });
`;

export const successfulResolveResponse = (cid: string): string => `
  ${READY}
  window.addEventListener("message", function(e) {
    if (e.data && e.data.namespace === "dotli:protocol" && e.data.method === "resolveDotName") {
      window.parent.postMessage({
        namespace: "dotli:protocol",
        kind: "response",
        id: e.data.id,
        ok: true,
        result: ${JSON.stringify(cid)},
      }, "*");
    }
  });
`;

/** How the fake answers `bitswap_v1_get` for one CID. `hold-first` holds the first ask and serves every later one. */
export type BlockMode = 'serve' | 'hold' | 'hold-first' | 'fail';

/** What the fake answers `resolveDotName` with. */
export type FakeResolve = { kind: 'cid'; cid: string } | { kind: 'fatal'; message: string };

export interface FakeProtocolOptions {
  resolve: FakeResolve;
  /** Hex of each block the fake can serve, by CID. */
  blocks?: Record<string, string>;
  /** Per CID. A CID with no mode is served. */
  modes?: Record<string, BlockMode>;
  /** What `resolveRootManifest` answers, as the protocol frame sends it. None published by default. */
  rootManifest?: unknown;
}

/** What a test reads and steers in the fake, through `window.__fakeProtocol` in the protocol frame. */
export interface FakeProtocolControl {
  /** `bitswap_v1_get` asks per CID, counted as they arrive. */
  gets: Record<string, number>;
  setMode: (cid: string, mode: BlockMode) => void;
  /** Answers every held ask for `cid` and serves the later ones. */
  release: (cid: string) => void;
}

// Serialized into the frame, so it uses nothing from its module scope and answers in the frame's own words.
function runFakeProtocol(options: FakeProtocolOptions): void {
  const blocks = options.blocks ?? {};
  const modes: Record<string, BlockMode> = { ...options.modes };
  const gets: Record<string, number> = {};
  const held: { cid: string; connectionId: string; rpcId: unknown }[] = [];
  const post = (message: Record<string, unknown>): void => {
    window.parent.postMessage({ namespace: 'dotli:protocol', ...message }, '*');
  };
  const respond = (id: unknown, result: unknown): void => {
    post({ kind: 'response', id, ok: true, result });
  };
  const answerBlock = (connectionId: string, rpcId: unknown, cid: string): void => {
    const hex = blocks[cid];
    const message =
      hex === undefined
        ? { jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: `no block ${cid}` } }
        : { jsonrpc: '2.0', id: rpcId, result: `0x${hex}` };
    post({ kind: 'chain-message', connectionId, message: JSON.stringify(message) });
  };
  const failBlock = (connectionId: string, rpcId: unknown, cid: string): void => {
    const message = { jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: `e2e: ${cid} refused` } };
    post({ kind: 'chain-message', connectionId, message: JSON.stringify(message) });
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

  window.addEventListener('message', event => {
    const data = event.data as {
      namespace?: string;
      kind?: string;
      id?: unknown;
      method?: string;
      payload?: { connectionId?: string; message?: string };
    } | null;
    if (data?.namespace !== 'dotli:protocol' || data.kind !== 'request') {
      return;
    }
    const method = data.method;
    if (method === 'resolveDotName') {
      if (options.resolve.kind === 'fatal') {
        post({ kind: 'fatal', message: options.resolve.message });
      } else {
        respond(data.id, options.resolve.cid);
      }
    } else if (method === 'resolveRootManifest') {
      respond(data.id, options.rootManifest ?? { kind: 'empty' });
    } else if (method === 'resolveExecutableManifest') {
      respond(data.id, { kind: 'empty' });
    } else if (method === 'localWalletRead') {
      respond(data.id, { status: 'none' });
    } else if (method === 'chainSend') {
      respond(data.id, null);
      const connectionId = data.payload?.connectionId ?? '';
      const rpc = JSON.parse(data.payload?.message ?? '{}') as { id?: unknown; method?: string; params?: string[] };
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
    } else {
      // Storage reads find nothing, and writes, connects and the warmup succeed.
      respond(data.id, null);
    }
  });
  post({ kind: 'listening' });
  post({ kind: 'ready' });
}

/** Serves the fake protocol frame for every protocol frame the page builds. */
export async function fakeProtocol(page: Page, options: FakeProtocolOptions): Promise<void> {
  await mockProtocolIframe(page, `(${runFakeProtocol.toString()})(${JSON.stringify(options)});`);
}

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
