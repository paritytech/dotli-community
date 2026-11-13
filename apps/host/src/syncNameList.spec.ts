// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { LabelStoreCursor } from '@dotli/resolver';
import type { NameListRecord } from '@dotli/storage';
import { syncNameList, type NameListReads } from './syncNameList.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type NetworkParams = {
  /** The label stores the factory lists, in creation order. */
  stores?: string[];
  /** Each store's entries, by address. A store's entry count is its list's length. */
  entries?: Record<string, string[]>;
  /** The labels whose app has a contenthash. */
  apps?: string[];
  /** A store whose read rejects with `error`. */
  broken?: { address: string; error: Error };
};

describe('syncNameList', () => {
  it('As a first-time visitor, I get every app label and the rest pending, saved per chunk of 16 stores', async () => {
    // Given: 20 stores with one new label each, every other one with an app
    const labels = Array.from({ length: 20 }, (_, index) => `name${String(index)}`);
    const apps = labels.filter((_, index) => index % 2 === 0);
    const unpublished = labels.filter((_, index) => index % 2 === 1);
    const stores = labels.map(label => `store-${label}`);
    const reads = createFakeReads({
      stores,
      entries: Object.fromEntries(labels.map(label => [`store-${label}`, [label]])),
      apps,
    });
    const save = createFakeSave();

    // When
    await syncNameList({ stored: null, network: 'paseo-next-v2', reads, save, now: () => NOW });

    // Then
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.lastCall?.[0]).toMatchObject({
      apps,
      pending: unpublished.map(label => ({ label, checkedAt: NOW })),
    });
  });

  it('As a returning visitor, I read only the stores and entries past my saved position', async () => {
    // Given: a saved position two entries into the first store, and a second store added since
    const stored = createRecord({ stores: [{ address: 'store-a', read: 2 }] });
    const reads = createFakeReads({
      stores: ['store-a', 'store-b'],
      entries: { 'store-a': ['alice', 'bob', 'carol'], 'store-b': ['dave'] },
    });

    // When
    await syncNameList({ stored, network: 'paseo-next-v2', reads, save: createFakeSave(), now: () => NOW });

    // Then
    expect(reads.readLabelStores).toHaveBeenCalledWith(1);
    expect(reads.readNewLabels).toHaveBeenCalledWith([
      { address: 'store-a', read: 2 },
      { address: 'store-b', read: 0 },
    ]);
  });

  it('As a returning visitor with nothing new, I get my saved list back and nothing is saved', async () => {
    // Given: a list that has read every entry, with a pending label checked within the day
    const stored = createRecord({
      stores: [{ address: 'store-a', read: 1 }],
      apps: ['alice'],
      pending: [{ label: 'bob', checkedAt: NOW - 1000 }],
    });
    const reads = createFakeReads({ stores: ['store-a'], entries: { 'store-a': ['alice'] } });
    const save = createFakeSave();

    // When
    const synced = await syncNameList({ stored, network: 'paseo-next-v2', reads, save, now: () => NOW });

    // Then
    expect(synced).toBe(stored);
    expect(save).not.toHaveBeenCalled();
  });

  it('As a returning visitor, I never check a label already in apps again', async () => {
    // Given: a new store that lists a label already known to have an app, beside a new one
    const stored = createRecord({ stores: [{ address: 'store-a', read: 1 }], apps: ['alice'] });
    const reads = createFakeReads({
      stores: ['store-a', 'store-b'],
      entries: { 'store-a': ['alice'], 'store-b': ['alice', 'bob'] },
    });

    // When
    await syncNameList({ stored, network: 'paseo-next-v2', reads, save: createFakeSave(), now: () => NOW });

    // Then
    expect(reads.readAppLabels.mock.calls.map(([labels]) => labels)).toEqual([['bob']]);
  });

  it('As a returning visitor, I check pending labels again after a day, moving one with an app to apps and stamping the rest', async () => {
    // Given: two labels last checked over a day ago, one of which has published an app since
    const stored = createRecord({
      pending: [
        { label: 'carol', checkedAt: NOW - DAY_MS - 1 },
        { label: 'dave', checkedAt: NOW - DAY_MS - 1 },
      ],
    });
    const reads = createFakeReads({ apps: ['carol'] });

    // When
    const synced = await syncNameList({
      stored,
      network: 'paseo-next-v2',
      reads,
      save: createFakeSave(),
      now: () => NOW,
    });

    // Then
    expect(synced).toMatchObject({ apps: ['carol'], pending: [{ label: 'dave', checkedAt: NOW }] });
  });

  it('As a returning visitor, I leave a pending label checked within the day unread', async () => {
    // Given: a label checked just under a day ago
    const stored = createRecord({ pending: [{ label: 'carol', checkedAt: NOW - DAY_MS + 1000 }] });
    const reads = createFakeReads({ apps: ['carol'] });

    // When
    await syncNameList({ stored, network: 'paseo-next-v2', reads, save: createFakeSave(), now: () => NOW });

    // Then
    expect(reads.readAppLabels).not.toHaveBeenCalled();
  });

  it('As a returning visitor, I see a pending label listed again in a new store stay pending and not become an app', async () => {
    // Given: a pending label, checked within the day, that a new store lists again and that has an app by now
    const stored = createRecord({
      stores: [{ address: 'store-a', read: 1 }],
      pending: [{ label: 'bob', checkedAt: NOW - 1000 }],
    });
    const reads = createFakeReads({
      stores: ['store-a', 'store-b'],
      entries: { 'store-a': ['bob'], 'store-b': ['bob'] },
      apps: ['bob'],
    });

    // When
    const synced = await syncNameList({
      stored,
      network: 'paseo-next-v2',
      reads,
      save: createFakeSave(),
      now: () => NOW,
    });

    // Then
    expect(synced).toMatchObject({ apps: [], pending: [{ label: 'bob', checkedAt: NOW - 1000 }] });
  });

  it('As a first-time visitor, I see a label listed in two chunks of stores kept once', async () => {
    // Given: 17 stores, the first and the last of which list the same label, which has no app
    const stores = Array.from({ length: 17 }, (_, index) => `store-${String(index)}`);
    const reads = createFakeReads({
      stores,
      entries: { 'store-0': ['dup'], 'store-16': ['dup'] },
    });

    // When
    const synced = await syncNameList({
      stored: null,
      network: 'paseo-next-v2',
      reads,
      save: createFakeSave(),
      now: () => NOW,
    });

    // Then
    expect(synced).toMatchObject({ apps: [], pending: [{ label: 'dup', checkedAt: NOW }] });
  });

  it('As a returning visitor with 300 stale pending labels, I check them in chunks of 256 and save after each', async () => {
    // Given: 300 labels last checked over a day ago
    const labels = Array.from({ length: 300 }, (_, index) => `name${String(index)}`);
    const stored = createRecord({ pending: labels.map(label => ({ label, checkedAt: NOW - DAY_MS - 1 })) });
    const reads = createFakeReads({});
    const save = createFakeSave();

    // When
    await syncNameList({ stored, network: 'paseo-next-v2', reads, save, now: () => NOW });

    // Then
    expect(reads.readAppLabels.mock.calls.map(([chunk]) => chunk.length)).toEqual([256, 44]);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('As a visitor whose read fails on the second chunk, I keep the first chunk saved and the sync rejects with that error', async () => {
    // Given: 20 stores with an app label each, and the 17th store's read failing
    const labels = Array.from({ length: 20 }, (_, index) => `name${String(index)}`);
    const stores = labels.map(label => `store-${label}`);
    const error = new Error('Asset Hub stopped');
    const reads = createFakeReads({
      stores,
      entries: Object.fromEntries(labels.map(label => [`store-${label}`, [label]])),
      apps: labels,
      broken: { address: 'store-name16', error },
    });
    const save = createFakeSave();

    // When
    const outcome = await syncNameList({ stored: null, network: 'paseo-next-v2', reads, save, now: () => NOW }).catch(
      (reason: unknown) => reason,
    );

    // Then
    expect(outcome).toBe(error);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.lastCall?.[0].apps).toEqual(labels.slice(0, 16));
  });
});

/** Reads over a fake network, as the resolver answers them. */
function createFakeReads({ stores = [], entries = {}, apps = [], broken }: NetworkParams) {
  return {
    readLabelStores: vi.fn<NameListReads['readLabelStores']>(known => Promise.resolve(stores.slice(known))),
    readNewLabels: vi.fn<NameListReads['readNewLabels']>((cursors: readonly LabelStoreCursor[]) => {
      if (broken !== undefined && cursors.some(c => c.address === broken.address)) {
        return Promise.reject(broken.error);
      }
      const labels = new Set<string>();
      const moved = cursors.map(cursor => {
        const held = entries[cursor.address] ?? [];
        for (const label of held.slice(cursor.read)) {
          labels.add(label);
        }
        return { address: cursor.address, read: held.length };
      });
      return Promise.resolve({ stores: moved, labels: [...labels] });
    }),
    readAppLabels: vi.fn<NameListReads['readAppLabels']>(labels =>
      Promise.resolve(new Set(labels.filter(label => apps.includes(label)))),
    ),
  } satisfies NameListReads;
}

function createFakeSave() {
  return vi.fn<(record: NameListRecord) => Promise<void>>(() => Promise.resolve());
}

function createRecord(overrides: Partial<NameListRecord>): NameListRecord {
  return { network: 'paseo-next-v2', stores: [], apps: [], pending: [], ...overrides };
}
