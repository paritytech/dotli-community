// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { Network } from '@dotli/config';
import { createDeferred } from '@dotli/shared';
import { createMemoryStorage } from '@dotli/shared/testing';
import type { WorkerExecutable } from './createNameSource.js';
import {
  createStorageExecutableCache,
  readChatCapability,
  readWorkerExecutable,
  type ExecutableCache,
} from './readWorkerExecutable.js';
import { bindReports } from '../../../testing/bindReports.js';
import { createBlockedStorage } from '../../../testing/createBlockedStorage.js';

type Params = {
  /** The entries the page's storage holds before the load, none by default. */
  seed?: Record<string, string>;
};

const CHAT_WORKER: WorkerExecutable = { entrypoint: 'index.js', includes: { chat: true }, cid: 'bafy-worker' };
const QUIET_WORKER: WorkerExecutable = { entrypoint: 'index.js', includes: {}, cid: 'bafy-quiet' };
const NETWORK: Network = 'paseo-next-v2';
const KEPT_KEY = `dotli:worker-executable:${NETWORK}:myapp`;

describe('worker executable', () => {
  it('As a visitor on a product that publishes a worker, I load it and the read answers and is kept for the next load', async () => {
    // Given
    const { stored, cache } = createPage();

    // When
    const executable = await readWorkerExecutable('myapp', readingWorker(CHAT_WORKER), { cache, network: NETWORK });

    // Then
    expect(executable).toEqual(CHAT_WORKER);
    expect(stored.getItem(KEPT_KEY)).toBe(JSON.stringify(CHAT_WORKER));
  });

  it('As a returning visitor whose product moved its worker, I load it and this load gets the kept worker at once while the next load gets the new one', async () => {
    // Given
    const { stored, cache } = createPage({ seed: { [KEPT_KEY]: JSON.stringify(CHAT_WORKER) } });
    const read = createDeferred<WorkerExecutable | null>();

    // When
    const executable = await readWorkerExecutable(
      'myapp',
      { readWorkerExecutable: () => read.promise },
      { cache, network: NETWORK },
    );
    read.resolve(QUIET_WORKER);
    await read.promise;

    // Then
    expect(executable).toEqual(CHAT_WORKER);
    expect(stored.getItem(KEPT_KEY)).toBe(JSON.stringify(QUIET_WORKER));
  });

  it('As a returning visitor on a product with no worker, I load it and the kept answer says so without waiting on the read', async () => {
    // Given
    const { cache } = createPage({ seed: { [KEPT_KEY]: 'null' } });

    // When
    const executable = await readWorkerExecutable(
      'myapp',
      { readWorkerExecutable: () => new Promise(() => undefined) },
      { cache, network: NETWORK },
    );

    // Then
    expect(executable).toBeNull();
  });

  it('As a returning visitor whose worker cannot be read, I load my product with the kept worker, which stays kept, and the failure is counted as expected', async () => {
    // Given
    const reported = createDeferred<undefined>();
    const { captures, counted } = bindReports({
      onReport: () => {
        reported.resolve(undefined);
      },
    });
    const { stored, cache } = createPage({ seed: { [KEPT_KEY]: JSON.stringify(CHAT_WORKER) } });
    const failure = new TypeError('offline');

    // When
    const executable = await readWorkerExecutable(
      'myapp',
      { readWorkerExecutable: () => Promise.reject(failure) },
      { cache, network: NETWORK },
    );
    await reported.promise;

    // Then
    expect({
      executable,
      kept: stored.getItem(KEPT_KEY),
      expected: captures.expected.mock.calls,
      captured: captures.exception.mock.calls,
      counted: counted('chat.capability'),
    }).toMatchObject({
      executable: CHAT_WORKER,
      kept: JSON.stringify(CHAT_WORKER),
      expected: [[failure, { step: 'worker_executable_read' }]],
      captured: [],
      counted: [{ outcome: 'error', reason: 'TypeError' }],
    });
  });

  it('As a visitor who switched networks, I load a label whose worker was kept on the other network and get the worker this network reads', async () => {
    // Given
    const { cache } = createPage();
    await readWorkerExecutable('myapp', readingWorker(CHAT_WORKER), { cache, network: 'previewnet' });

    // When
    const executable = await readWorkerExecutable('myapp', readingWorker(QUIET_WORKER), { cache, network: NETWORK });

    // Then
    expect(executable).toEqual(QUIET_WORKER);
  });

  it('As a visitor whose browser blocks storage, I load my product and it still answers from the read', async () => {
    // Given
    const cache = createStorageExecutableCache({ storage: createBlockedStorage() });

    // When
    const executable = await readWorkerExecutable('myapp', readingWorker(CHAT_WORKER), { cache, network: NETWORK });

    // Then
    expect(executable).toEqual(CHAT_WORKER);
  });
});

describe('chat capability', () => {
  it.each([
    ['a worker that includes chat', 'on', CHAT_WORKER, true],
    ['a worker that leaves chat out', 'off', QUIET_WORKER, false],
    ['no worker', 'off', null, false],
  ])('As a visitor on a product with %s, I load it and chat is %s', async (_name, _chat, worker, chatOn) => {
    // Given
    const { cache } = createPage();

    // When
    const chat = await readChatCapability('myapp', readingWorker(worker), { cache, network: NETWORK });

    // Then
    expect(chat).toBe(chatOn);
  });

  it('As a visitor whose worker cannot be read, I load my product and it gets no chat this load', async () => {
    // Given
    const { cache } = createPage();

    // When
    const chat = await readChatCapability(
      'myapp',
      { readWorkerExecutable: () => Promise.reject(new Error('offline')) },
      { cache, network: NETWORK },
    );

    // Then
    expect(chat).toBe(false);
  });

  it('As a returning visitor whose product dropped chat, I load it and this load keeps the kept answer while the next load gets the new one', async () => {
    // Given
    const { cache } = createPage({ seed: { [KEPT_KEY]: JSON.stringify(CHAT_WORKER) } });
    const read = createDeferred<WorkerExecutable | null>();

    // When
    const chat = await readChatCapability(
      'myapp',
      { readWorkerExecutable: () => read.promise },
      { cache, network: NETWORK },
    );
    read.resolve(QUIET_WORKER);
    await read.promise;
    const next = await readChatCapability(
      'myapp',
      { readWorkerExecutable: () => new Promise(() => undefined) },
      { cache, network: NETWORK },
    );

    // Then
    expect([chat, next]).toEqual([true, false]);
  });

  it('As a returning visitor whose chat answer was kept before workers were, I load my product and chat answers from it at once until the read replaces it', async () => {
    // Given
    const { stored, cache } = createPage({ seed: { 'dotli:chat-capable:myapp': '1' } });
    const read = createDeferred<WorkerExecutable | null>();

    // When
    const chat = await readChatCapability(
      'myapp',
      { readWorkerExecutable: () => read.promise },
      { cache, network: NETWORK },
    );
    read.resolve(QUIET_WORKER);
    await read.promise;
    const next = cache.getChat('myapp', NETWORK);

    // Then
    expect({ chat, legacy: stored.getItem('dotli:chat-capable:myapp'), next }).toEqual({
      chat: true,
      legacy: null,
      next: false,
    });
  });
});

/** Returns a name source whose worker read answers `worker`. */
function readingWorker(worker: WorkerExecutable | null): {
  readWorkerExecutable: () => Promise<WorkerExecutable | null>;
} {
  return { readWorkerExecutable: () => Promise.resolve(worker) };
}

/** Returns a page load whose storage holds `seed`, and what it stores. */
function createPage({ seed = {} }: Params = {}): { stored: Storage; cache: ExecutableCache } {
  const stored = createMemoryStorage({ entries: seed });
  return { stored, cache: createStorageExecutableCache({ storage: stored }) };
}
