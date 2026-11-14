// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import type { Network } from '@dotli/config';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import type { LabelStoreCursor } from '@dotli/resolver';
import { CHAIN_HALTED_ERROR_DATA } from '@dotli/shared';
import type { NameListRecord } from '@dotli/storage';
import { atom } from 'nanostores';
import { createLandingNameList } from './landingNameList.js';
import type { SettingsState } from './state/settingsState.js';
import type { NameListReads } from './syncNameList.js';

type HarnessParams = {
  /** What the last visit saved. */
  stored?: NameListRecord | null;
  /** The settings the boot has set, null while it has not. */
  settings?: SettingsState | null;
  /** The reads that differ from a list with no label stores. */
  reads?: Partial<NameListReads>;
  /** Whether opening the reads resolves, stays pending or fails to load its chunk. */
  open?: 'ready' | 'pending' | 'failed';
};

const SETTINGS: SettingsState = {
  backend: 'rpc-gateway',
  cache: { skipCidCache: false, skipArchiveCache: false, skipWorkerCache: false },
  network: 'previewnet',
  enabledNetworks: ['previewnet'],
  sharedWorkerAvailable: false,
  verified: false,
};

const NOW = 1_700_000_000_000;

describe('landing name list', () => {
  it('As a returning visitor, I open the landing page and see my stored app labels before the sync reads anything', async () => {
    // Given a stored list and reads that are still opening
    const stored: NameListRecord = { network: 'previewnet', stores: [], apps: ['alpha'], pending: [] };
    const { nameList, opening } = setupNameList({ stored, open: 'pending' });

    // When the sync starts and asks for its reads
    nameList.start();
    await opening;

    // Then
    expect(nameList.labels.get()).toEqual(['alpha']);
  });

  it("As a visitor, I open the landing page before the boot sets my settings and the sync waits, then reads my network's list", async () => {
    // Given no settings yet
    const { nameList, settings, gets, opened, released } = setupNameList({ settings: null });

    // When the sync starts, and the boot sets the settings after it
    nameList.start();
    settings.set(SETTINGS);
    await released;

    // Then
    expect(gets).toEqual(['previewnet']);
    expect(opened).toEqual([SETTINGS]);
  });

  it('As a visitor, I watch the labels follow each saved step and the lease is released once the sync ends', async () => {
    // Given seventeen label stores, two chunks, whose new labels are all with an app but `beta`
    const addresses = Array.from({ length: 17 }, (_, index) => `0x${String(index).padStart(40, '0')}`);
    const { nameList, events, released } = setupNameList({
      reads: {
        readLabelStores: () => Promise.resolve(addresses),
        readNewLabels: (stores: readonly LabelStoreCursor[]) =>
          Promise.resolve({
            stores: stores.map(store => ({ ...store, read: 1 })),
            labels: stores[0]?.address === addresses[0] ? ['alpha', 'beta'] : ['gamma'],
          }),
        readAppLabels: (labels: readonly string[]) =>
          Promise.resolve(new Set(labels.filter(label => label !== 'beta'))),
      },
    });

    // When
    nameList.start();
    await released;

    // Then
    expect(events).toEqual([
      'labels ',
      'saved alpha',
      'labels alpha',
      'saved alpha,gamma',
      'labels alpha,gamma',
      'released',
    ]);
  });

  it('As a visitor whose sync reads a chain that kept halting, I see it reported as expected and the lease is still released', async () => {
    // Given a read that fails as the environment makes it
    const reports = recordReports({ onFinished: onTestFinished });
    const counted = waitForCount();
    const { nameList, events } = setupNameList({
      reads: {
        readLabelStores: () =>
          Promise.reject(Object.assign(new Error('chain halted'), { data: CHAIN_HALTED_ERROR_DATA })),
      },
    });

    // When
    nameList.start();
    await counted;

    // Then
    expect(reports.expected.map(report => report.step)).toEqual(['sync']);
    expect(reports.exceptions).toEqual([]);
    expect(events).toContain('released');
  });

  it('As a visitor whose sync fails for another reason, I see it reported as a defect and the lease is still released', async () => {
    // Given a read that fails in the code
    const reports = recordReports({ onFinished: onTestFinished });
    const counted = waitForCount();
    const { nameList, events } = setupNameList({
      reads: {
        readLabelStores: () => Promise.reject(new TypeError('bad slot')),
      },
    });

    // When
    nameList.start();
    await counted;

    // Then
    expect(reports.exceptions.map(report => report.step)).toEqual(['sync']);
    expect(events).toContain('released');
  });

  it('As a visitor whose labels listener throws, I see the sync reported as a defect and no rejection escapes', async () => {
    // Given a listener of the labels that throws on the first change
    const reports = recordReports({ onFinished: onTestFinished });
    const counted = waitForCount();
    const { nameList } = setupNameList();
    nameList.labels.listen(() => {
      throw new TypeError('listener broke');
    });

    // When
    nameList.start();
    await counted;

    // Then
    expect(reports.exceptions.map(report => report.step)).toEqual(['sync']);
  });

  it('As a visitor whose resolver chunk fails to load, I see the miss reported and no sync runs', async () => {
    // Given reads whose chunk fails to load
    const reports = recordReports({ onFinished: onTestFinished });
    const counted = Promise.withResolvers<undefined>();
    const metrics = bindRecordingSentry({
      onFinished: onTestFinished,
      onRecord: () => {
        counted.resolve(undefined);
      },
    });
    const { nameList, events } = setupNameList({ open: 'failed' });

    // When
    nameList.start();
    await counted.promise;

    // Then
    expect(reports.expected.map(report => report.step)).toEqual(['name_list_reads']);
    expect(metrics.counted('name_list.sync')).toEqual([]);
    expect(events).not.toContain('released');
  });

  it('As the suggestion island, I start twice and one sync runs', async () => {
    // Given
    const { nameList, opened, released } = setupNameList();

    // When
    nameList.start();
    nameList.start();
    await released;

    // Then
    expect(opened).toHaveLength(1);
  });
});

/**
 * Builds the landing name list over a fake store, fake reads and its own settings, and logs each change of its labels,
 * each save and the release, in order.
 */
function setupNameList({ stored = null, settings = SETTINGS, reads = {}, open = 'ready' }: HarnessParams = {}) {
  const events: string[] = [];
  const gets: Network[] = [];
  const opened: SettingsState[] = [];
  const opening = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const settingsStore = atom<SettingsState | null>(settings);
  const fakeReads = {
    readLabelStores: () => Promise.resolve([]),
    readNewLabels: (stores: readonly LabelStoreCursor[]) => Promise.resolve({ stores: [...stores], labels: [] }),
    readAppLabels: () => Promise.resolve(new Set<string>()),
    ...reads,
    release: () => {
      events.push('released');
      released.resolve(undefined);
    },
  };
  const nameList = createLandingNameList({
    store: {
      get: (network: Network) => {
        gets.push(network);
        return Promise.resolve(stored);
      },
      set: (record: NameListRecord) => {
        events.push(`saved ${record.apps.join(',')}`);
        return Promise.resolve();
      },
    },
    openReads: (current: SettingsState) => {
      opened.push(current);
      opening.resolve(undefined);
      switch (open) {
        case 'ready':
          return Promise.resolve(fakeReads);
        case 'pending':
          return new Promise(() => undefined);
        case 'failed':
          return Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
      }
    },
    settings: settingsStore,
    now: () => NOW,
  });
  nameList.labels.listen(labels => {
    events.push(`labels ${labels.join(',')}`);
  });
  return {
    nameList,
    settings: settingsStore,
    events,
    gets,
    opened,
    opening: opening.promise,
    released: released.promise,
  };
}

/** Settles once the first metric of the test is counted. */
function waitForCount(): Promise<undefined> {
  const counted = Promise.withResolvers<undefined>();
  bindRecordingSentry({
    onFinished: onTestFinished,
    onRecord: () => {
      counted.resolve(undefined);
    },
  });
  return counted.promise;
}
