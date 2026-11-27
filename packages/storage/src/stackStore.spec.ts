// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createStackStore, type StackStore, type StoredStack } from './stackStore.js';
import type { DotliIdb } from './db.js';
import { abortAtCommit } from './testing/abortAtCommit.js';
import { createMemoryIdb, type MemoryIdb } from './testing/index.js';

// Each test gets a fresh database, so no test sees another's records.
let idb: MemoryIdb;
let store: StackStore;

beforeEach(() => {
  idb = createMemoryIdb();
  store = createStackStore({ idb });
});

const PASEO = 'paseo-next-v2';

const STACK: StoredStack = {
  network: PASEO,
  pointer: 'trinity://paseo-next-v2',
  descriptor: new TextEncoder().encode('{"sequence":4}'),
  sequence: 4,
};

const SPEC_A = `0x${'aa'.repeat(32)}`;
const SPEC_B = `0x${'bb'.repeat(32)}`;

const refusedConnect: DotliIdb = {
  connect: () => Promise.reject(new DOMException('closed', 'InvalidStateError')),
  keyRange: () => IDBKeyRange,
};

/** A database that refuses commits once `refuse` is called, so a test can store a record first. */
function createRefusableIdb(): { idb: MemoryIdb; refuse: () => void } {
  let refusing = false;
  return {
    idb: createMemoryIdb({
      onTransaction: transaction => {
        if (refusing) {
          abortAtCommit(transaction);
        }
      },
    }),
    refuse: () => {
      refusing = true;
    },
  };
}

describe('stored stack', () => {
  it('As a stack reader, I read back the stack I stored for my network', async () => {
    // Given
    await store.setStackUnlessLightSpecs(STACK);

    // When
    const read = await store.getStack(PASEO);

    // Then
    expect(read).toEqual(STACK);
  });

  it('As a stack reader, I find no stack for a network I never stored', async () => {
    // Given
    await store.setStackUnlessLightSpecs(STACK);

    // When
    const read = await store.getStack('previewnet');

    // Then
    expect(read).toBeNull();
  });
});

describe('stored light specs', () => {
  it('As a light client, I find no specs for a network I never stored', async () => {
    // When
    const specs = await store.getLightSpecs(PASEO);

    // Then
    expect(specs).toEqual(new Map());
  });

  it('As a light client, I store a newer set and a spec it no longer names is gone', async () => {
    // Given
    await store.setLightSpecs(
      PASEO,
      new Map([
        [SPEC_A, new Uint8Array([1])],
        [SPEC_B, new Uint8Array([2])],
      ]),
    );

    // When
    await store.setLightSpecs(PASEO, new Map([[SPEC_B, new Uint8Array([2])]]));

    // Then
    expect(await store.getLightSpecs(PASEO)).toEqual(new Map([[SPEC_B, new Uint8Array([2])]]));
  });
});

describe('stored stack with its light specs', () => {
  it('As a light client, I store a stack with the specs I accepted it with and read both back', async () => {
    // Given
    const specs = new Map([[SPEC_A, new Uint8Array([1])]]);

    // When
    await store.setStackAndLightSpecs(STACK, specs);

    // Then
    expect({ stack: await store.getStack(PASEO), specs: await store.getLightSpecs(PASEO) }).toEqual({
      stack: STACK,
      specs,
    });
  });
});

describe('writers of one copy', () => {
  it("As a core's stack reader on a device whose light client keeps specs for my network, I store a newer copy and the light client's copy stays", async () => {
    // Given
    await store.setStackAndLightSpecs(STACK, new Map([[SPEC_A, new Uint8Array([1])]]));

    // When
    await store.setStackUnlessLightSpecs({ ...STACK, sequence: 5 });

    // Then
    expect(await store.getStack(PASEO)).toEqual(STACK);
  });

  it.each([
    ["core's stack reader", (stack: StoredStack) => store.setStackUnlessLightSpecs(stack)],
    [
      'light client',
      (stack: StoredStack) => store.setStackAndLightSpecs(stack, new Map([[SPEC_A, new Uint8Array([1])]])),
    ],
  ])('As a %s, I store a copy older than the stored one and nothing changes', async (_writer, write) => {
    // Given
    const newer = { ...STACK, sequence: 5 };
    await store.setStackUnlessLightSpecs(newer);

    // When
    await write(STACK);

    // Then
    expect({ stack: await store.getStack(PASEO), specs: await store.getLightSpecs(PASEO) }).toEqual({
      stack: newer,
      specs: new Map(),
    });
  });

  it("As a light client, I keep a copy over a newer one stored under the stack's former link, and mine replaces it", async () => {
    // Given
    await store.setStackUnlessLightSpecs({ ...STACK, pointer: 'trinity://former', sequence: 9 });

    // When
    await store.setStackAndLightSpecs(STACK, new Map());

    // Then
    expect(await store.getStack(PASEO)).toEqual(STACK);
  });
});

describe('stack store failures', () => {
  it('As a stack reader, I read from a database that refuses me and get null and the failure is reported', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const refusing = createStackStore({ idb: refusedConnect });

    // When
    const read = await refusing.getStack(PASEO);

    // Then
    expect(read).toBeNull();
    expect(sentry.counted('cache.storage')).toEqual([
      expect.objectContaining({ outcome: 'error', surface: 'stack', step: 'read' }),
    ]);
  });

  it('As a stack reader, I store a stack whose commit aborts and the old one stays and the failure is reported', async () => {
    // Given a stored stack, then a database that refuses every commit, as a full quota does
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { idb: refusable, refuse } = createRefusableIdb();
    const refusing = createStackStore({ idb: refusable });
    await refusing.setStackUnlessLightSpecs(STACK);
    refuse();

    // When
    await refusing.setStackUnlessLightSpecs({ ...STACK, sequence: 5 });

    // Then
    expect(await refusing.getStack(PASEO)).toEqual(STACK);
    expect(sentry.counted('cache.storage')).toEqual([
      expect.objectContaining({ outcome: 'error', surface: 'stack', step: 'write' }),
    ]);
  });

  it('As a light client, I read specs from a database that refuses me and get none and the failure is reported', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const refusing = createStackStore({ idb: refusedConnect });

    // When
    const specs = await refusing.getLightSpecs(PASEO);

    // Then
    expect(specs).toEqual(new Map());
    expect(sentry.counted('cache.storage')).toEqual([
      expect.objectContaining({ outcome: 'error', surface: 'light_specs', step: 'read' }),
    ]);
  });

  it('As a light client, I store specs whose commit aborts, the old set stays and the failure is reported', async () => {
    // Given a stored set, then a database that refuses every commit
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { idb: refusable, refuse } = createRefusableIdb();
    const refusing = createStackStore({ idb: refusable });
    const stored = new Map([[SPEC_A, new Uint8Array([1])]]);
    await refusing.setLightSpecs(PASEO, stored);
    refuse();

    // When
    await refusing.setLightSpecs(PASEO, new Map([[SPEC_B, new Uint8Array([2])]]));

    // Then
    expect(await refusing.getLightSpecs(PASEO)).toEqual(stored);
    expect(sentry.counted('cache.storage')).toEqual([
      expect.objectContaining({ outcome: 'error', surface: 'light_specs', step: 'write' }),
    ]);
  });

  it('As a light client, I store a stack with its specs whose commit aborts, both old records stay and one stack write failure is reported', async () => {
    // Given a stored stack and set, then a database that refuses every commit
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { idb: refusable, refuse } = createRefusableIdb();
    const refusing = createStackStore({ idb: refusable });
    const stored = new Map([[SPEC_A, new Uint8Array([1])]]);
    await refusing.setStackAndLightSpecs(STACK, stored);
    refuse();

    // When
    await refusing.setStackAndLightSpecs({ ...STACK, sequence: 5 }, new Map([[SPEC_B, new Uint8Array([2])]]));

    // Then
    expect({ stack: await refusing.getStack(PASEO), specs: await refusing.getLightSpecs(PASEO) }).toEqual({
      stack: STACK,
      specs: stored,
    });
    expect(sentry.counted('cache.storage')).toEqual([
      expect.objectContaining({ outcome: 'error', surface: 'stack', step: 'write' }),
    ]);
  });
});
