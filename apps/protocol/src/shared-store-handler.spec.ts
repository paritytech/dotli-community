// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { SITE_ID } from '@dotli/config';
import { bindCaptureSink } from '@dotli/metrics';
import type { ProtocolEnvelope, ProtocolRequestEnvelope, ProtocolRequestMap } from '@dotli/protocol';
import { createSharedStoreHandler, type SharedAuthChannel, type SharedStoreDeps } from './shared-store-handler.js';

const HOST = 'http://host-playground.localhost:5173';
const OTHER_HOST = 'http://landing.localhost:5173';
const PRODUCT = 'http://bafy.app.localhost:5173';

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

function memoryStorage(): ReturnType<SharedStoreDeps['storage']> & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: key => {
      entries.delete(key);
    },
  };
}

interface FakeChannel {
  channel: SharedAuthChannel;
  posted: unknown[];
  /** A message another tab's iframe broadcast. */
  deliver: (data: unknown) => void;
}

function fakeChannel(post: (message: unknown) => void = () => undefined): FakeChannel {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posted: unknown[] = [];
  const channel = {
    postMessage: (message: unknown) => {
      post(message);
      posted.push(message);
    },
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
      listeners.delete(listener);
    },
  } as unknown as SharedAuthChannel;
  return {
    channel,
    posted,
    deliver: data => {
      for (const listener of listeners) {
        listener(new MessageEvent('message', { data }));
      }
    },
  };
}

function setup(overrides: Partial<SharedStoreDeps> = {}): {
  handler: ReturnType<typeof createSharedStoreHandler>;
  storage: ReturnType<typeof memoryStorage>;
  channel: FakeChannel;
  toParent: { message: ProtocolEnvelope; origin: string }[];
} {
  const storage = memoryStorage();
  const channel = fakeChannel();
  const toParent: { message: ProtocolEnvelope; origin: string }[] = [];
  const handler = createSharedStoreHandler({
    storage: () => storage,
    channel: channel.channel,
    parent: {
      postMessage: (message, origin) => {
        toParent.push({ message, origin });
      },
    },
    initialParentOrigin: null,
    ...overrides,
  });
  return { handler, storage, channel, toParent };
}

function request<M extends keyof ProtocolRequestMap>(
  method: M,
  payload: ProtocolRequestMap[M],
  id = 'r1',
): ProtocolRequestEnvelope<M> {
  return { namespace: 'dotli:protocol', kind: 'request', id, method, payload };
}

function answers(run: (respond: (envelope: ProtocolEnvelope) => void) => void): ProtocolEnvelope[] {
  const out: ProtocolEnvelope[] = [];
  run(envelope => out.push(envelope));
  return out;
}

const ok = (id: string, result: unknown): ProtocolEnvelope => ({
  namespace: 'dotli:protocol',
  kind: 'response',
  id,
  ok: true,
  result,
});

describe('the shared auth store', () => {
  it('As a host page, I write a shared auth key and read it back', () => {
    // Given
    const { handler } = setup();
    handler.auth(request('authStorageWrite', { siteId: SITE_ID, key: 'session', value: 'abc' }), HOST, () => undefined);

    // When
    const read = answers(respond => {
      handler.auth(request('authStorageRead', { siteId: SITE_ID, key: 'session' }, 'r2'), HOST, respond);
    });

    // Then
    expect(read).toEqual([ok('r2', 'abc')]);
  });

  it("As a host page in another tab, I hear this tab's auth writes and clears", () => {
    // Given
    const { handler, channel } = setup();

    // When
    handler.auth(request('authStorageWrite', { siteId: SITE_ID, key: 'session', value: 'abc' }), HOST, () => undefined);
    handler.auth(request('authStorageClear', { siteId: SITE_ID, key: 'session' }), HOST, () => undefined);

    // Then
    expect(channel.posted).toEqual([
      { siteId: SITE_ID, key: 'session', value: 'abc' },
      { siteId: SITE_ID, key: 'session', value: null },
    ]);
  });

  it("As a host page, a sibling tab's auth write reaches me at the origin of my last request", () => {
    // Given a parent first known from the referrer, then from its own request
    const { handler, channel, toParent } = setup({ initialParentOrigin: OTHER_HOST });
    handler.auth(request('authStorageRead', { siteId: SITE_ID, key: 'session' }), HOST, () => undefined);

    // When another tab writes
    channel.deliver({ siteId: SITE_ID, key: 'session', value: 'xyz' });

    // Then
    expect(toParent).toEqual([
      {
        message: {
          namespace: 'dotli:protocol',
          kind: 'auth-storage-changed',
          siteId: SITE_ID,
          key: 'session',
          value: 'xyz',
        },
        origin: HOST,
      },
    ]);
  });

  it("As a host page under a strict referrer policy, a sibling tab's write waits until I have asked once", () => {
    // Given a parent whose origin the referrer did not give
    const { channel, toParent } = setup();

    // When another tab writes
    channel.deliver({ siteId: SITE_ID, key: 'session', value: 'xyz' });

    // Then nothing is posted to an unknown origin
    expect(toParent).toEqual([]);
  });

  it('As a dotli user, a product page cannot read my shared session', () => {
    // Given
    const { handler, storage } = setup();
    storage.setItem(`TRUAPI_${SITE_ID}_session`, 'secret');

    // When
    const read = (): void => {
      handler.auth(request('authStorageRead', { siteId: SITE_ID, key: 'session' }), PRODUCT, () => undefined);
    };

    // Then
    expect(read).toThrow(`Shared auth request denied from origin: ${PRODUCT}`);
  });

  it('As a dotli operator, a failed broadcast is reported and the write is still answered', () => {
    // Given
    const failure = new DOMException('could not be cloned', 'DataCloneError');
    const { handler } = setup({
      channel: fakeChannel(() => {
        throw failure;
      }).channel,
    });
    captures.exception.mockClear();

    // When
    const written = answers(respond => {
      handler.auth(request('authStorageWrite', { siteId: SITE_ID, key: 'session', value: 'abc' }), HOST, respond);
    });

    // Then
    expect(written).toEqual([ok('r1', true)]);
    expect(captures.exception).toHaveBeenCalledWith(failure, { flow: 'storage', step: 'shared_auth_broadcast' });
  });

  it('As a dotli integrator, a key outside the allowed characters is refused', () => {
    // Given
    const { handler } = setup();

    // When
    const write = (): void => {
      handler.auth(
        request('authStorageWrite', { siteId: SITE_ID, key: 'no spaces', value: 'x' }),
        HOST,
        () => undefined,
      );
    };

    // Then
    expect(write).toThrow('Invalid shared auth key: no spaces');
  });
});

describe('the shared auth store origin rules', () => {
  it('As a host page, a refused product request does not move where sibling tab writes are sent', () => {
    // Given an allowed parent known from its own request
    const { handler, channel, toParent } = setup();
    handler.auth(request('authStorageRead', { siteId: SITE_ID, key: 'session' }), HOST, () => undefined);

    // When a product origin asks and is refused, then another tab writes
    expect(() => {
      handler.auth(request('authStorageRead', { siteId: SITE_ID, key: 'session' }), PRODUCT, () => undefined);
    }).toThrow(`Shared auth request denied from origin: ${PRODUCT}`);
    channel.deliver({ siteId: SITE_ID, key: 'session', value: 'xyz' });

    // Then only the allowed parent origin is posted to
    expect(toParent.map(entry => entry.origin)).toEqual([HOST]);
  });

  it('As a host page with no known parent, a refused product request does not make me a relay target', () => {
    // Given
    const { handler, channel, toParent } = setup();

    // When
    expect(() => {
      handler.auth(request('authStorageRead', { siteId: SITE_ID, key: 'session' }), PRODUCT, () => undefined);
    }).toThrow();
    channel.deliver({ siteId: SITE_ID, key: 'session', value: 'xyz' });

    // Then
    expect(toParent).toEqual([]);
  });

  it('As a dotli user, storage blocked by the browser is answered per request and the handler still starts', () => {
    // Given storage that throws on access
    const blocked = new DOMException('storage is blocked', 'SecurityError');
    const { handler } = setup({
      storage: () => {
        throw blocked;
      },
    });

    // When
    const read = (): void => {
      handler.auth(request('authStorageRead', { siteId: SITE_ID, key: 'session' }), HOST, () => undefined);
    };

    // Then
    expect(read).toThrow(blocked);
  });
});

describe('the shared mode store', () => {
  it('As a host page, I keep the protocol mode apart from the session and no other tab is told', () => {
    // Given
    const { handler, storage, channel } = setup();

    // When
    handler.mode(
      request('modeStorageWrite', { siteId: SITE_ID, key: 'session', value: 'direct' }),
      HOST,
      () => undefined,
    );
    const read = answers(respond => {
      handler.mode(request('modeStorageRead', { siteId: SITE_ID, key: 'session' }, 'r2'), HOST, respond);
    });

    // Then
    expect(read).toEqual([ok('r2', 'direct')]);
    expect([...storage.entries.keys()]).toEqual([`DOTLI_MODE_${SITE_ID}_session`]);
    expect(channel.posted).toEqual([]);
  });

  it('As a host page, I clear the protocol mode', () => {
    // Given
    const { handler, storage } = setup();
    storage.setItem(`DOTLI_MODE_${SITE_ID}_mode`, 'rpc');

    // When
    const cleared = answers(respond => {
      handler.mode(request('modeStorageClear', { siteId: SITE_ID, key: 'mode' }), HOST, respond);
    });

    // Then
    expect(cleared).toEqual([ok('r1', true)]);
    expect(storage.entries.size).toBe(0);
  });
});
