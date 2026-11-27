// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import type { BundledStack } from '@dotli/config';
import { recordReports } from '@dotli/metrics/testing';
import { toHex } from '@dotli/shared';
import { createManualTimers, type ManualTimers } from '@dotli/shared/testing';
import { createStackReader } from './stackReader.js';
import { createStackStore, type StackStore } from './stackStore.js';
import { createMemoryIdb } from './testing/index.js';

const PASEO = 'paseo-next-v2';
const DESCRIPTOR_URL = 'https://stack.example/.well-known/trinity-stack.json';
const SIGNING_PREFIX = new TextEncoder().encode('trinity-stack/descriptor/v1');

// The publisher's key pair, made once, so each test signs its own descriptors.
let keys: CryptoKeyPair;
let pointer: string;

beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  pointer = `polkadotapp://stack?key=${toHex(publicKey)}&url=${encodeURIComponent(DESCRIPTOR_URL)}`;
});

// Each test gets a fresh database and clock.
let store: StackStore;
let timers: ManualTimers;

beforeEach(() => {
  store = createStackStore({ idb: createMemoryIdb() });
  timers = createManualTimers();
});

/**
 * A descriptor signed by the publisher, as served: the envelope around the base64 of `payload`'s JSON. A `served`
 * payload goes out in place of the signed one, as a copy altered after signing.
 */
async function sign(
  payload: Record<string, unknown>,
  { served = payload }: { served?: Record<string, unknown> } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const message = new Uint8Array([...SIGNING_PREFIX, ...body]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, message));
  const envelope = { $v: 1, payload: btoa(JSON.stringify(served)), signature: toHex(signature) };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function signDescriptor(sequence: number): Promise<Uint8Array<ArrayBuffer>> {
  return sign({ $v: 1, sequence, chains: [] });
}

function loadBundledOf(descriptor: Uint8Array): () => Promise<BundledStack> {
  return () => Promise.resolve({ pointer, descriptor, allowsReservedValues: true });
}

function serve(body: BodyInit | null, init?: ResponseInit): typeof fetch {
  return () => Promise.resolve(new Response(body, init));
}

async function storeCopy(sequence: number, link = pointer): Promise<Uint8Array> {
  const descriptor = await signDescriptor(sequence);
  await store.setStack({ network: PASEO, pointer: link, descriptor, sequence });
  return descriptor;
}

describe('the copy to start from', () => {
  it('As a light client with a stored copy newer than the bundled one, I start from it without waiting on the fetch', async () => {
    // Given a live fetch that never answers
    const stored = await storeCopy(5);
    const reader = createStackReader({
      store,
      loadBundled: loadBundledOf(await signDescriptor(4)),
      fetch: () => new Promise<Response>(() => undefined),
      timers,
    });

    // When
    const { stack } = await reader.read(PASEO);

    // Then
    expect(stack).toEqual({ pointer, descriptor: stored, allowsReservedValues: true });
  });

  it('As a light client with a bundled copy newer than the stored one, I start from the bundled copy', async () => {
    // Given
    await storeCopy(3);
    const bundled = await signDescriptor(5);
    const reader = createStackReader({ store, loadBundled: loadBundledOf(bundled), fetch: serve(bundled), timers });

    // When
    const { stack } = await reader.read(PASEO);

    // Then
    expect(stack.descriptor).toBe(bundled);
  });

  it('As a light client with no stored copy, I wait for the live copy, start from it and store it', async () => {
    // Given
    const live = await signDescriptor(5);
    const reader = createStackReader({
      store,
      loadBundled: loadBundledOf(await signDescriptor(4)),
      fetch: serve(live),
      timers,
    });

    // When
    const { stack, newer } = await reader.read(PASEO);

    // Then
    expect(stack.descriptor).toEqual(live);
    expect(await newer).toBeNull();
    expect(await store.getStack(PASEO)).toMatchObject({ pointer, sequence: 5 });
  });

  it('As a light client whose stored copy is under another link, I ignore it and wait for the live copy', async () => {
    // Given a newer copy kept under the stack's former link
    await storeCopy(9, 'polkadotapp://stack?key=0x00&url=https%3A%2F%2Fformer.example%2F');
    const live = await signDescriptor(5);
    const reader = createStackReader({
      store,
      loadBundled: loadBundledOf(await signDescriptor(4)),
      fetch: serve(live),
      timers,
    });

    // When
    const { stack } = await reader.read(PASEO);

    // Then
    expect(stack.descriptor).toEqual(live);
  });

  it.each([
    ['the network fails', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the server answers 502', serve(null, { status: 502 })],
    ['the body is over the cap', serve(new Uint8Array(1024 * 1024 + 1))],
  ])(
    'As a light client with no stored copy, I start from the bundled copy when %s, and the failure is reported',
    async (_case, fetchResource: typeof fetch) => {
      // Given
      const reports = recordReports({ onFinished: onTestFinished });
      const bundled = await signDescriptor(4);
      const reader = createStackReader({ store, loadBundled: loadBundledOf(bundled), fetch: fetchResource, timers });

      // When
      const reading = reader.read(PASEO);
      await timers.advance(10_000);
      const { stack } = await reading;

      // Then
      expect(stack.descriptor).toBe(bundled);
      expect(await store.getStack(PASEO)).toBeNull();
      expect(reports.expected).toMatchObject([{ step: 'stack_live_fetch' }]);
    },
  );
});

describe('the live copy behind a start', () => {
  it('As a light client starting from a stored copy, I get the newer live copy once it is stored', async () => {
    // Given
    const stored = await storeCopy(5);
    const live = await signDescriptor(6);
    const reader = createStackReader({
      store,
      loadBundled: loadBundledOf(await signDescriptor(4)),
      fetch: serve(live),
      timers,
    });

    // When
    const { stack, newer } = await reader.read(PASEO);

    // Then
    expect(stack.descriptor).toEqual(stored);
    expect((await newer)?.descriptor).toEqual(live);
    expect(await store.getStack(PASEO)).toMatchObject({ sequence: 6 });
  });

  it('As a light client, I get no newer copy and keep the stored one when the live copy is older', async () => {
    // Given
    await storeCopy(5);
    const reader = createStackReader({
      store,
      loadBundled: loadBundledOf(await signDescriptor(3)),
      fetch: serve(await signDescriptor(4)),
      timers,
    });

    // When
    const { newer } = await reader.read(PASEO);

    // Then
    expect(await newer).toBeNull();
    expect(await store.getStack(PASEO)).toMatchObject({ sequence: 5 });
  });

  it.each([
    [
      'its payload was altered after signing',
      () => sign({ $v: 1, sequence: 6, chains: [] }, { served: { $v: 1, sequence: 7, chains: [] } }),
    ],
    ['it is an HTML page answered with success', () => Promise.resolve('<html><body>Bad gateway</body></html>')],
    ['its payload names another version', () => sign({ $v: 2, sequence: 6, chains: [] })],
  ])(
    'As a light client, I refuse a live copy when %s, keep the stored one, and the refusal is reported',
    async (_case, makeBody: () => Promise<BodyInit>) => {
      // Given
      const reports = recordReports({ onFinished: onTestFinished });
      await storeCopy(5);
      const reader = createStackReader({
        store,
        loadBundled: loadBundledOf(await signDescriptor(4)),
        fetch: serve(await makeBody()),
        timers,
      });

      // When
      const { newer } = await reader.read(PASEO);

      // Then
      expect(await newer).toBeNull();
      expect(await store.getStack(PASEO)).toMatchObject({ sequence: 5 });
      expect(reports.expected).toMatchObject([{ step: 'stack_live_check' }]);
    },
  );

  it('As a light client on a platform without Ed25519, I store no live copy, and the gap is reported', async () => {
    // Given
    const reports = recordReports({ onFinished: onTestFinished });
    const bundled = await signDescriptor(4);
    const reader = createStackReader({
      store,
      loadBundled: loadBundledOf(bundled),
      fetch: serve(await signDescriptor(5)),
      subtle: {
        importKey: () => Promise.reject(new DOMException('Unrecognized algorithm name', 'NotSupportedError')),
        verify: () => Promise.resolve(true),
      },
      timers,
    });

    // When
    const { stack } = await reader.read(PASEO);

    // Then
    expect(stack.descriptor).toBe(bundled);
    expect(await store.getStack(PASEO)).toBeNull();
    expect(reports.expected).toMatchObject([{ step: 'stack_live_check' }]);
  });
});

describe('repeated reads', () => {
  it('As a page booting two cores on one network, I read twice and the live copy is fetched once', async () => {
    // Given
    let fetches = 0;
    const live = await signDescriptor(5);
    const reader = createStackReader({
      store,
      loadBundled: loadBundledOf(await signDescriptor(4)),
      fetch: () => {
        fetches += 1;
        return Promise.resolve(new Response(live));
      },
      timers,
    });

    // When
    const [first, second] = await Promise.all([reader.read(PASEO), reader.read(PASEO)]);

    // Then
    expect(second).toBe(first);
    expect(fetches).toBe(1);
  });

  it('As a page whose bundled copy failed to load, I read again and the load runs again', async () => {
    // Given a bundled copy whose first load fails
    const bundled = await signDescriptor(4);
    let loads = 0;
    const reader = createStackReader({
      store,
      loadBundled: () => {
        loads += 1;
        return loads === 1
          ? Promise.reject(new TypeError('Failed to fetch dynamically imported module'))
          : loadBundledOf(bundled)();
      },
      fetch: serve(bundled),
      timers,
    });
    await expect(reader.read(PASEO)).rejects.toThrow(TypeError);

    // When
    const { stack } = await reader.read(PASEO);

    // Then
    expect(stack.descriptor).toEqual(bundled);
  });
});
