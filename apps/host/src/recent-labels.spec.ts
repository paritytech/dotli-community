// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindLogSink, type LogLevel } from '@dotli/shared';
import { parseRecentLabels, serializeRecentLabels } from '@dotli/storage';
import { createLazyRecentLabels, createRecentLabels, landingRecentLabels, type RecentMirror } from './recent-labels.js';
import { memoryStorage } from '@dotli/shared/testing';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { memorySharedChannel, type MemorySharedChannel } from './runtime/shared-mode.fake.js';

// The list is written on `<label>.<root>` and read on the bare root, so the shared cross-subdomain store is
// authoritative and localStorage only a mirror. The channel stands in for that store, a memory Storage for the mirror.

const KEY = 'dotli_recent';

let channel: MemorySharedChannel;
let local: Storage;
let mirror: RecentMirror;

function sharedList(): unknown {
  const raw = channel.store.get(KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

function mirrorList(): unknown {
  const raw = local.getItem(KEY);
  return raw === null ? null : JSON.parse(raw);
}

const captures = { exception: vi.fn(), expected: vi.fn() };
let metrics: RecordingSentry;
let unbindCaptures: () => void;

describe('recent labels across subdomains', () => {
  beforeEach(() => {
    channel = memorySharedChannel();
    local = memoryStorage();
    mirror = {
      read: () => parseRecentLabels(local.getItem(KEY)),
      write: labels => {
        local.setItem(KEY, serializeRecentLabels(labels));
      },
    };
    metrics = bindRecordingSentry({ onFinished: onTestFinished });
    unbindCaptures = bindCaptureSink(captures);
  });

  afterEach(() => {
    unbindCaptures();
    vi.clearAllMocks();
  });

  it("As a visitor on the landing page, I see the shared list rather than this origin's mirror", async () => {
    // Given: a list recorded by some other subdomain, plus a stale mirror
    channel.store.set(KEY, '["explore","staking"]');
    local.setItem(KEY, '["stale"]');

    // When
    const loaded = await createRecentLabels(channel, mirror).load();

    // Then
    expect(loaded).toEqual(['explore', 'staking']);
  });

  it('As a visitor upgrading from a build that wrote only localStorage, I keep my list and it seeds the shared one', async () => {
    // Given: a device upgrading from the build that wrote only localStorage
    local.setItem(KEY, '["explore","staking"]');

    // When
    const loaded = await createRecentLabels(channel, mirror).load();

    // Then
    expect(loaded).toEqual(['explore', 'staking']);
    expect(sharedList()).toEqual(['explore', 'staking']);
  });

  it('As a visitor who removed my last name, I load an empty list and the stale mirror does not re-seed it', async () => {
    // Given: a stale mirror survives
    channel.store.set(KEY, '[]');
    local.setItem(KEY, '["removed"]');

    // When
    const loaded = await createRecentLabels(channel, mirror).load();

    // Then
    expect(loaded).toEqual([]);
    expect(mirrorList()).toEqual([]);
  });

  it('As a visitor whose shared store is unreachable, I see the mirror instead', async () => {
    // Given
    local.setItem(KEY, '["explore"]');
    channel.readFails = true;

    // When
    const loaded = await createRecentLabels(channel, mirror).load();

    // Then
    expect(loaded).toEqual(['explore']);
  });

  it('As a visitor, I resolve a name and it joins the shared list instead of clobbering it', async () => {
    // Given: another subdomain already recorded a visit
    channel.store.set(KEY, '["explore"]');

    // When
    await createRecentLabels(channel, mirror).record('staking');

    // Then
    expect(sharedList()).toEqual(['staking', 'explore']);
    expect(mirrorList()).toEqual(['staking', 'explore']);
  });

  it('As a visitor, I come back to a name and it moves to the front without a duplicate', async () => {
    // Given
    channel.store.set(KEY, '["a","b","c"]');

    // When
    await createRecentLabels(channel, mirror).record('c');

    // Then
    expect(sharedList()).toEqual(['c', 'a', 'b']);
  });

  it("As a visitor, I resolve a label that can't be a .dot name and it is never recorded", async () => {
    // When
    await createRecentLabels(channel, mirror).record('Not A Label');

    // Then
    expect(sharedList()).toBeUndefined();
    expect(channel.writes).toEqual([]);
  });

  it('As a visitor, I remove a name and it leaves the shared list and the mirror', async () => {
    // Given
    channel.store.set(KEY, '["explore","typo-name"]');

    // When
    await createRecentLabels(channel, mirror).forget('typo-name');

    // Then
    expect(sharedList()).toEqual(['explore']);
    expect(mirrorList()).toEqual(['explore']);
  });

  it('As a visitor, I remove two names in quick succession and both stay removed', async () => {
    // Given
    channel.store.set(KEY, '["a","b","c"]');
    const recents = createRecentLabels(channel, mirror);

    // When
    await Promise.all([recents.forget('a'), recents.forget('b')]);

    // Then
    expect(sharedList()).toEqual(['c']);
    expect(mirrorList()).toEqual(['c']);
  });

  it('As a visitor, I resolve a name while removing another and both changes stay', async () => {
    // Given
    channel.store.set(KEY, '["a","b"]');
    const recents = createRecentLabels(channel, mirror);

    // When: the record and the remove overlap
    await Promise.all([recents.record('c'), recents.forget('a')]);

    // Then
    expect(sharedList()).toEqual(['c', 'b']);
    expect(mirrorList()).toEqual(['c', 'b']);
  });

  it('As a visitor whose shared store cannot be read, I resolve a name, the mirror moves on and the failure is warned', async () => {
    // Given: a mirror, and a shared store that cannot be read
    local.setItem(KEY, '["explore"]');
    channel.readFails = true;
    const logged: [LogLevel, string][] = [];
    bindLogSink({
      emit: (level, message) => {
        logged.push([level, message]);
      },
    });

    // When
    await createRecentLabels(channel, mirror).record('staking');

    // Then
    expect(mirrorList()).toEqual(['staking', 'explore']);
    expect(logged).toEqual([
      ['warn', '[dot.li recent] Shared read failed; updating the per-origin mirror: shared store unreachable'],
    ]);
    expect(captures.expected).toHaveBeenCalledWith(expect.any(Error), { flow: 'storage', step: 'recent_labels' });
    expect(metrics.counted('recent_labels.update')).toEqual([{ outcome: 'error', reason: 'read' }]);
  });

  it("As a visitor whose shared store refuses the write, my visit is kept in this origin's list and the failure is reported once", async () => {
    // Given
    channel.store.set(KEY, '["explore"]');
    channel.writeFails = true;

    // When
    await createRecentLabels(channel, mirror).record('staking');

    // Then: the shared store kept its old value, the mirror moved on
    expect(sharedList()).toEqual(['explore']);
    expect(mirrorList()).toEqual(['staking', 'explore']);
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(expect.any(Error), { flow: 'storage', step: 'recent_labels' });
    expect(captures.exception).not.toHaveBeenCalled();
    expect(metrics.counted('recent_labels.update')).toEqual([{ outcome: 'error', reason: 'write' }]);
  });

  it('As a visitor upgrading while the shared store refuses writes, I keep my list and the seeding failure is reported', async () => {
    // Given
    local.setItem(KEY, '["explore"]');
    channel.writeFails = true;
    const reported = new Promise<void>(resolve => {
      captures.expected.mockImplementationOnce(() => {
        resolve();
      });
    });

    // When
    const loaded = await createRecentLabels(channel, mirror).load();

    // Then
    expect(loaded).toEqual(['explore']);
    await reported;
    expect(metrics.counted('recent_labels.update')).toEqual([{ outcome: 'error', reason: 'migrate' }]);
    expect(captures.expected).toHaveBeenCalledTimes(1);
  });

  it('As a visitor upgrading from a build that wrote only localStorage, a name I resolve while my list seeds the shared one sticks with the list', async () => {
    // Given a mirror from the old build, and a shared store whose first write lands only when the test lets it
    local.setItem(KEY, '["explore"]');
    let landSeed: () => void = () => undefined;
    const seedHeld = new Promise<void>(resolve => {
      landSeed = resolve;
    });
    let held = false;
    const slow = {
      ...channel,
      write: async (key: string, value: string): Promise<void> => {
        if (!held) {
          held = true;
          await seedHeld;
        }
        await channel.write(key, value);
      },
    };
    const recents = createRecentLabels(slow, mirror);
    await recents.load();

    // When a name is resolved while the seed write is still on its way, and the seed then lands
    const recorded = recents.record('staking');
    landSeed();
    await recorded;

    // Then the shared list holds both the seeded list and the new name
    expect(sharedList()).toEqual(['staking', 'explore']);
  });

  it('As a visitor who resolves two names at once on one page, both are recorded', async () => {
    // Given: the page's list, built once over its shared store
    const pageRecents = createLazyRecentLabels(() => channel, mirror);

    // When
    await Promise.all([pageRecents().record('explore'), pageRecents().record('staking')]);

    // Then
    expect(sharedList()).toEqual(['staking', 'explore']);
  });

  it('As a frequent visitor, I resolve a name and the shared list keeps the eight latest', async () => {
    // Given
    const eight = Array.from({ length: 8 }, (_, i) => `label${String(i)}`);
    channel.store.set(KEY, JSON.stringify(eight));

    // When
    await createRecentLabels(channel, mirror).record('newest');

    // Then
    expect(sharedList()).toEqual(['newest', ...eight.slice(0, 7)]);
  });

  it('As a visitor on a landing page another site frames, my recents ask the shared store nothing, as that page configures no protocol frame', () => {
    // Given
    const list = vi.fn(() => createRecentLabels(channel, mirror));
    const framed = { self: {}, top: {} };

    // When
    const recents = landingRecentLabels(framed, list);

    // Then
    expect(recents).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });

  it('As a visitor on a landing page of its own, my recents come from the page list', () => {
    // Given
    const own = createRecentLabels(channel, mirror);
    const view = {};

    // When
    const recents = landingRecentLabels({ self: view, top: view }, () => own);

    // Then
    expect(recents).toBe(own);
  });
});
