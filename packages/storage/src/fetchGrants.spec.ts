// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { createFetchGrantStore, type FetchGrantStore } from './fetchGrants.js';
import { abortAtCommit } from './testing/abortAtCommit.js';
import { createMemoryIdb } from './testing/index.js';

const MYAPP_API = { label: 'myapp', host: 'api.example.com' };

// Each test gets a fresh database, so no test sees another's decisions.
let store: FetchGrantStore;

beforeEach(() => {
  store = createFetchGrantStore({ idb: createMemoryIdb() });
});

describe('fetch grants', () => {
  it('As a user, I allow a product to fetch a host and the decision reads back', async () => {
    // Given
    await store.save(MYAPP_API, 'allowed');

    // When
    const decision = await store.read(MYAPP_API);

    // Then
    expect(decision).toBe('allowed');
  });

  it('As a user, I never answered for a host and it reads as no decision', async () => {
    // When
    const decision = await store.read(MYAPP_API);

    // Then
    expect(decision).toBeNull();
  });

  it('As a user, I deny a host I allowed before and the later decision is kept', async () => {
    // Given
    await store.save(MYAPP_API, 'allowed');
    await store.save(MYAPP_API, 'denied');

    // When
    const decision = await store.read(MYAPP_API);

    // Then
    expect(decision).toBe('denied');
  });

  it('As a user, I allow one product a host and another product of that host still has no decision', async () => {
    // Given
    await store.save(MYAPP_API, 'allowed');

    // When
    const decision = await store.read({ label: 'other', host: MYAPP_API.host });

    // Then
    expect(decision).toBeNull();
  });

  it('As a user, I clear one decision and the product keeps its others', async () => {
    // Given
    const otherHost = { label: 'myapp', host: 'cdn.example.com' };
    await store.save(MYAPP_API, 'allowed');
    await store.save(otherHost, 'denied');

    // When
    await store.clear(MYAPP_API);

    // Then
    expect([await store.read(MYAPP_API), await store.read(otherHost)]).toEqual([null, 'denied']);
  });

  it('As a product, I save a decision whose commit aborts and the save rejects', async () => {
    // Given a database that refuses every commit, as a full quota does
    const refusing = createFetchGrantStore({ idb: createMemoryIdb({ onTransaction: abortAtCommit }) });

    // When
    const saving = refusing.save(MYAPP_API, 'allowed');

    // Then
    await expect(saving).rejects.toThrow();
  });
});
