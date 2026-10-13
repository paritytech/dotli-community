// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { ProtocolEnvelope, ProtocolRequestEnvelope } from '@dotli/protocol';
import { createFrameRouter, type FrameRefusal, type FrameRouteHandler, type FrameRouterDeps } from './frame-router.js';

const HOST = 'https://doom.dot.li';
const STRANGER = 'https://evil.example';

interface Page {
  /** What the router posted back to this page, with the target origin it named. */
  heard: { message: unknown; origin: string }[];
  /** Resolves once the router has posted its first answer to this page. */
  answered: Promise<void>;
  source: MessageEventSource;
}

function page(): Page {
  const heard: { message: unknown; origin: string }[] = [];
  let answer: () => void = () => undefined;
  const answered = new Promise<void>(resolve => {
    answer = resolve;
  });
  const source = {
    postMessage: (message: unknown, origin: string) => {
      heard.push({ message, origin });
      answer();
    },
  } as unknown as MessageEventSource;
  return { heard, answered, source };
}

function request(method: ProtocolRequestEnvelope['method'], id = 'r1'): ProtocolRequestEnvelope {
  return { namespace: 'dotli:protocol', kind: 'request', id, method, payload: {} };
}

function send(target: EventTarget, from: Page, origin: string, data: unknown): void {
  const event = new MessageEvent('message', { data, origin });
  Object.defineProperty(event, 'source', { value: from.source });
  target.dispatchEvent(event);
}

function setup(routes: FrameRouterDeps['routes']): {
  target: EventTarget;
  router: ReturnType<typeof createFrameRouter>;
  refusals: FrameRefusal[];
} {
  const target = new EventTarget();
  const refusals: FrameRefusal[] = [];
  const router = createFrameRouter({
    target,
    isAllowedOrigin: origin => origin === HOST,
    routes,
    onRefused: refusal => {
      refusals.push(refusal);
    },
  });
  return { target, router, refusals };
}

const answer =
  (result: unknown): FrameRouteHandler =>
  (req, _origin, respond) => {
    respond({ namespace: 'dotli:protocol', kind: 'response', id: req.id, ok: true, result });
  };

describe('the protocol frame router', () => {
  it('As a host page, my shared auth request reaches the auth store and its answer comes back to me', () => {
    // Given
    const auth = vi.fn<FrameRouteHandler>(answer('abc'));
    const { target } = setup({ auth, mode: answer('mode'), wallet: answer('wallet') });
    const host = page();

    // When
    send(target, host, HOST, request('authStorageRead'));

    // Then
    expect(auth).toHaveBeenCalledTimes(1);
    expect(host.heard).toEqual([
      { message: { namespace: 'dotli:protocol', kind: 'response', id: 'r1', ok: true, result: 'abc' }, origin: HOST },
    ]);
  });

  it('As a dotli user, a request from a site that is not a dotli host is refused before any store sees it', () => {
    // Given
    const wallet = vi.fn<FrameRouteHandler>(answer('entropy'));
    const { target, refusals } = setup({ wallet });
    const stranger = page();

    // When
    send(target, stranger, STRANGER, request('localWalletRead'));

    // Then
    expect(wallet).not.toHaveBeenCalled();
    expect(stranger.heard).toEqual([]);
    expect(refusals).toEqual([{ route: 'wallet', reason: 'origin', origin: STRANGER }]);
  });

  it('As a host page, a store that refuses my request answers me with its reason', () => {
    // Given
    const { target, refusals } = setup({
      mode: () => {
        throw new Error('Invalid shared mode key: no spaces');
      },
    });
    const host = page();

    // When
    send(target, host, HOST, request('modeStorageWrite'));

    // Then
    expect(host.heard).toHaveLength(1);
    expect(host.heard[0]).toMatchObject({
      message: { kind: 'response', id: 'r1', ok: false, error: 'Invalid shared mode key: no spaces' },
      origin: HOST,
    });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ route: 'mode', reason: 'failed', request: request('modeStorageWrite') });
  });

  it('As a host page, a request whose handler fails later is still answered', async () => {
    // Given
    const { target } = setup({ wallet: () => Promise.reject(new Error('storage read failed')) });
    const host = page();

    // When
    send(target, host, HOST, request('localWalletRead'));
    await host.answered;

    // Then
    expect(host.heard).toHaveLength(1);
    expect(host.heard[0]).toMatchObject({
      message: { kind: 'response', id: 'r1', ok: false, error: 'storage read failed' },
      origin: HOST,
    });
  });

  it('As a host page, a chain request reaches the engine once the protocol mode has booted', () => {
    // Given a router that serves the stores but has no engine yet
    const { target, router } = setup({ auth: answer('abc') });
    const host = page();
    send(target, host, HOST, request('resolveDotName', 'early'));

    // When the engine comes up
    const chain = vi.fn<FrameRouteHandler>(answer('0xcid'));
    router.setRoute('chain', chain);
    send(target, host, HOST, request('resolveDotName', 'late'));

    // Then only the request sent after it is served
    expect(chain).toHaveBeenCalledTimes(1);
    expect(host.heard).toHaveLength(1);
    expect(host.heard[0]).toMatchObject({ message: { id: 'late', ok: true, result: '0xcid' }, origin: HOST });
  });

  it('As a dotli user, I see a stranger site asking for a route not served yet get neither a refusal nor an answer', () => {
    // Given a router that serves the stores but has no engine yet
    const { target, refusals } = setup({ auth: answer('abc') });
    const stranger = page();

    // When a stranger sends a chain request
    send(target, stranger, STRANGER, request('resolveDotName'));

    // Then it is dropped like any early chain request
    expect(refusals).toEqual([]);
    expect(stranger.heard).toEqual([]);
  });

  it("As a dotli user, I see a stranger site's chain request refused before the engine sees it", () => {
    // Given a router with the engine up
    const chain = vi.fn<FrameRouteHandler>(answer('0xcid'));
    const { target, refusals } = setup({ chain });
    const stranger = page();

    // When a stranger sends a chain request
    send(target, stranger, STRANGER, request('resolveDotName'));

    // Then the engine never sees it, and the refusal names the chain route
    expect(chain).not.toHaveBeenCalled();
    expect(stranger.heard).toEqual([]);
    expect(refusals).toEqual([{ route: 'chain', reason: 'origin', origin: STRANGER }]);
  });

  it('As a dotli integrator, messages that are not protocol requests are left alone', () => {
    // Given
    const chain = vi.fn<FrameRouteHandler>(answer(true));
    const { target, refusals } = setup({ chain });
    const host = page();
    const response: ProtocolEnvelope = { namespace: 'dotli:protocol', kind: 'response', id: 'x', ok: true, result: 1 };

    // When
    send(target, host, HOST, response);
    send(target, host, HOST, { type: 'something-else' });
    send(target, host, STRANGER, 'hello');

    // Then
    expect(chain).not.toHaveBeenCalled();
    expect(refusals).toEqual([]);
  });

  it('As a dotli integrator, a stopped router serves nothing', () => {
    // Given
    const auth = vi.fn<FrameRouteHandler>(answer('abc'));
    const { target, router } = setup({ auth });

    // When
    router.stop();
    send(target, page(), HOST, request('authStorageRead'));

    // Then
    expect(auth).not.toHaveBeenCalled();
  });
});
