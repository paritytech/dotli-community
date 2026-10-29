// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindLogSink, createDeferred, type LogLevel } from '@dotli/shared';
import { createRecentLabels } from './createRecentLabels.js';
import { createStorageMirror, type RecentMirror } from './createStorageMirror.js';
import { createMemoryStorage } from '@dotli/shared/testing';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { createMemorySharedChannel, type MemorySharedChannel } from './runtime/sharedMode.fake.js';

// The list is written on `<label>.<root>` and read on the bare root, so the shared cross-subdomain store is
// authoritative and localStorage only a mirror. The channel stands in for that store, a memory Storage for the mirror.

/** The stores a list reads and writes, and the sinks its failures reach, bound until the case ends. */
type Stand = {
  channel: MemorySharedChannel;
  local: Storage;
  mirror: RecentMirror;
  metrics: RecordingSentry;
  captures: { exception: Mock; expected: Mock };
  /** Returns the shared list as stored, or undefined when none is. */
  readSharedList: () => unknown;
  /** Returns this origin's mirror as stored, or null when none is. */
  readMirrorList: () => unknown;
};

const KEY = 'dotli_recent';

describe('recent labels across subdomains', () => {
  it("As a visitor on the landing page, I load my list and see the shared one rather than this origin's mirror", async () => {
    // Given: a list recorded by some other subdomain, plus a stale mirror
    const { channel, local, mirror } = setupStand();
    channel.store.set(KEY, '["explore","staking"]');
    local.setItem(KEY, '["stale"]');

    // When
    const loaded = await createRecentLabels({ channel, mirror }).load();

    // Then
    expect(loaded).toEqual(['explore', 'staking']);
  });

  it('As a visitor upgrading from a build that wrote only localStorage, I keep my list and it seeds the shared one', async () => {
    // Given: a device upgrading from the build that wrote only localStorage
    const { channel, local, mirror, readSharedList } = setupStand();
    local.setItem(KEY, '["explore","staking"]');

    // When
    const loaded = await createRecentLabels({ channel, mirror }).load();

    // Then
    expect(loaded).toEqual(['explore', 'staking']);
    expect(readSharedList()).toEqual(['explore', 'staking']);
  });

  it('As a visitor who removed my last name, I load an empty list and the stale mirror does not re-seed it', async () => {
    // Given: a stale mirror survives
    const { channel, local, mirror, readMirrorList } = setupStand();
    channel.store.set(KEY, '[]');
    local.setItem(KEY, '["removed"]');

    // When
    const loaded = await createRecentLabels({ channel, mirror }).load();

    // Then
    expect(loaded).toEqual([]);
    expect(readMirrorList()).toEqual([]);
  });

  it('As a visitor whose shared store is unreachable, I load my list and see the mirror instead', async () => {
    // Given
    const { channel, local, mirror } = setupStand();
    local.setItem(KEY, '["explore"]');
    channel.readFails = true;

    // When
    const loaded = await createRecentLabels({ channel, mirror }).load();

    // Then
    expect(loaded).toEqual(['explore']);
  });

  it('As a visitor, I resolve a name and it joins the shared list instead of clobbering it', async () => {
    // Given: another subdomain already recorded a visit
    const { channel, mirror, readSharedList, readMirrorList } = setupStand();
    channel.store.set(KEY, '["explore"]');

    // When
    await createRecentLabels({ channel, mirror }).record('staking');

    // Then
    expect(readSharedList()).toEqual(['staking', 'explore']);
    expect(readMirrorList()).toEqual(['staking', 'explore']);
  });

  it('As a visitor, I come back to a name and it moves to the front without a duplicate', async () => {
    // Given
    const { channel, mirror, readSharedList } = setupStand();
    channel.store.set(KEY, '["alpha","beta","gamma"]');

    // When
    await createRecentLabels({ channel, mirror }).record('gamma');

    // Then
    expect(readSharedList()).toEqual(['gamma', 'alpha', 'beta']);
  });

  it("As a visitor, I resolve a label that can't be a .dot name and it is never recorded", async () => {
    // Given
    const { channel, mirror, readSharedList } = setupStand();

    // When
    await createRecentLabels({ channel, mirror }).record('Not A Label');

    // Then
    expect(readSharedList()).toBeUndefined();
    expect(channel.writes).toEqual([]);
  });

  it('As a visitor, I remove a name and it leaves the shared list and the mirror', async () => {
    // Given
    const { channel, mirror, readSharedList, readMirrorList } = setupStand();
    channel.store.set(KEY, '["explore","typo-name"]');

    // When
    await createRecentLabels({ channel, mirror }).forget('typo-name');

    // Then
    expect(readSharedList()).toEqual(['explore']);
    expect(readMirrorList()).toEqual(['explore']);
  });

  it('As a visitor, I remove two names in quick succession and both stay removed', async () => {
    // Given
    const { channel, mirror, readSharedList, readMirrorList } = setupStand();
    channel.store.set(KEY, '["alpha","beta","gamma"]');
    const recents = createRecentLabels({ channel, mirror });

    // When
    await Promise.all([recents.forget('alpha'), recents.forget('beta')]);

    // Then
    expect(readSharedList()).toEqual(['gamma']);
    expect(readMirrorList()).toEqual(['gamma']);
  });

  it('As a visitor, I resolve a name while removing another and both changes stay', async () => {
    // Given
    const { channel, mirror, readSharedList, readMirrorList } = setupStand();
    channel.store.set(KEY, '["alpha","beta"]');
    const recents = createRecentLabels({ channel, mirror });

    // When: the record and the remove overlap
    await Promise.all([recents.record('gamma'), recents.forget('alpha')]);

    // Then
    expect(readSharedList()).toEqual(['gamma', 'beta']);
    expect(readMirrorList()).toEqual(['gamma', 'beta']);
  });

  it('As a visitor whose shared store cannot be read, I resolve a name, the mirror moves on and the failure is warned', async () => {
    // Given: a mirror, and a shared store that cannot be read
    const { channel, local, mirror, metrics, captures, readMirrorList } = setupStand();
    local.setItem(KEY, '["explore"]');
    channel.readFails = true;
    const logged: LogLevel[] = [];
    onTestFinished(
      bindLogSink({
        emit({ level }) {
          logged.push(level);
        },
      }),
    );

    // When
    await createRecentLabels({ channel, mirror }).record('staking');

    // Then
    expect(readMirrorList()).toEqual(['staking', 'explore']);
    expect(logged).toEqual(['warn']);
    expect(captures.expected).toHaveBeenCalledWith(expect.any(Error), { flow: 'storage', step: 'recent_labels' });
    expect(metrics.counted('recent_labels.update')).toEqual([{ outcome: 'error', reason: 'read' }]);
  });

  it("As a visitor whose shared store refuses the write, I resolve a name and it is kept in this origin's list while the failure is reported once", async () => {
    // Given
    const { channel, mirror, metrics, captures, readSharedList, readMirrorList } = setupStand();
    channel.store.set(KEY, '["explore"]');
    channel.writeFails = true;

    // When
    await createRecentLabels({ channel, mirror }).record('staking');

    // Then: the shared store kept its old value, the mirror moved on
    expect(readSharedList()).toEqual(['explore']);
    expect(readMirrorList()).toEqual(['staking', 'explore']);
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(expect.any(Error), { flow: 'storage', step: 'recent_labels' });
    expect(captures.exception).not.toHaveBeenCalled();
    expect(metrics.counted('recent_labels.update')).toEqual([{ outcome: 'error', reason: 'write' }]);
  });

  it('As a visitor upgrading while the shared store refuses writes, I keep my list and the seeding failure is reported', async () => {
    // Given
    const { channel, local, mirror, metrics, captures } = setupStand();
    local.setItem(KEY, '["explore"]');
    channel.writeFails = true;
    const reported = createDeferred<undefined>();
    captures.expected.mockImplementationOnce(() => {
      reported.resolve(undefined);
    });

    // When
    const loaded = await createRecentLabels({ channel, mirror }).load();
    await reported.promise;

    // Then
    expect(loaded).toEqual(['explore']);
    expect(metrics.counted('recent_labels.update')).toEqual([{ outcome: 'error', reason: 'migrate' }]);
    expect(captures.expected).toHaveBeenCalledTimes(1);
  });

  it('As a visitor upgrading from a build that wrote only localStorage, I resolve a name while my list seeds the shared one and it sticks with the list', async () => {
    // Given a mirror from the old build, and a shared store whose first write lands only when the test lets it
    const { channel, local, mirror, readSharedList } = setupStand();
    local.setItem(KEY, '["explore"]');
    const seed = createDeferred<undefined>();
    let held = false;
    const slow = {
      ...channel,
      async write(key: string, value: string): Promise<void> {
        if (!held) {
          held = true;
          await seed.promise;
        }
        await channel.write(key, value);
      },
    };
    const recents = createRecentLabels({ channel: slow, mirror });
    await recents.load();

    // When a name is resolved while the seed write is still on its way, and the seed then lands
    const recorded = recents.record('staking');
    seed.resolve(undefined);
    await recorded;

    // Then the shared list holds both the seeded list and the new name
    expect(readSharedList()).toEqual(['staking', 'explore']);
  });

  it('As a frequent visitor, I resolve a name and the shared list keeps the eight latest', async () => {
    // Given
    const { channel, mirror, readSharedList } = setupStand();
    const eight = Array.from({ length: 8 }, (_, index) => `label${String(index)}`);
    channel.store.set(KEY, JSON.stringify(eight));

    // When
    await createRecentLabels({ channel, mirror }).record('newest');

    // Then
    expect(readSharedList()).toEqual(['newest', ...eight.slice(0, 7)]);
  });
});

/** Builds fresh stores and binds recording sinks for the failures until the case ends. */
function setupStand(): Stand {
  const channel = createMemorySharedChannel();
  const local = createMemoryStorage();
  const captures = { exception: vi.fn(), expected: vi.fn() };
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  onTestFinished(bindCaptureSink(captures));
  return {
    channel,
    local,
    mirror: createStorageMirror({ storage: local }),
    metrics,
    captures,
    readSharedList(): unknown {
      const raw = channel.store.get(KEY);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    readMirrorList(): unknown {
      const raw = local.getItem(KEY);
      return raw === null ? null : JSON.parse(raw);
    },
  };
}
