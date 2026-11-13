// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createNameList, type NameList, type NameListRecord } from './nameList.js';
import { abortAtCommit } from './testing/abortAtCommit.js';
import { createMemoryIdb, type MemoryIdb } from './testing/index.js';

// Each test gets a fresh database, so no test sees another's records.
let idb: MemoryIdb;
let list: NameList;

beforeEach(() => {
  idb = createMemoryIdb();
  list = createNameList({ idb });
});

const PASEO = 'paseo-next-v2';

const SYNCED: NameListRecord = {
  network: PASEO,
  stores: [{ address: `0x${'ab'.repeat(20)}`, read: 3 }],
  apps: ['doom'],
  pending: [{ label: 'chess', checkedAt: 1_700_000_000_000 }],
};

describe('name list round-trip', () => {
  it('As the landing page, I read back the name list I saved for my network', async () => {
    // Given
    await list.set(SYNCED);

    // When
    const read = await list.get(PASEO);

    // Then
    expect(read).toEqual(SYNCED);
  });

  it('As the landing page, I find no list for a network I never synced', async () => {
    // Given
    await list.set(SYNCED);

    // When
    const read = await list.get('previewnet');

    // Then
    expect(read).toBeNull();
  });

  it('As the landing page, I save a newer list and the next read returns it instead of the old one', async () => {
    // Given
    const newer: NameListRecord = { network: PASEO, stores: [], apps: ['doom', 'chess'], pending: [] };
    await list.set(SYNCED);

    // When
    await list.set(newer);

    // Then
    expect(await list.get(PASEO)).toEqual(newer);
  });
});

describe('name list failure reporting', () => {
  it('As the landing page, I save a list whose commit aborts and the save resolves and is reported', async () => {
    // Given a database that refuses every commit, as a full quota does
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const refusing = createNameList({ idb: createMemoryIdb({ onTransaction: abortAtCommit }) });

    // When
    await refusing.set(SYNCED);

    // Then
    expect(sentry.counted('cache.storage')).toEqual([
      expect.objectContaining({ outcome: 'error', surface: 'name_list', step: 'write' }),
    ]);
    expect(await refusing.get(PASEO)).toBeNull();
  });

  it('As the landing page, I read from a database that refuses me and get null and the failure is reported', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const refusing = createNameList({
      idb: {
        connect: () => Promise.reject(new DOMException('closed', 'InvalidStateError')),
        keyRange: () => IDBKeyRange,
      },
    });

    // When
    const read = await refusing.get(PASEO);

    // Then
    expect(read).toBeNull();
    expect(sentry.counted('cache.storage')).toEqual([
      expect.objectContaining({ outcome: 'error', surface: 'name_list', step: 'read' }),
    ]);
  });
});
