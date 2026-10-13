// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { configureModeStorage, getCacheSettings, getNetwork, persistDefaults, setNetwork } from '@dotli/config';
import { bindCaptureSink } from '@dotli/metrics';
import { createSharedModeBootstrap, type SharedChannel } from './shared-mode.js';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { memoryStorage } from '@dotli/shared/testing';

let local: Storage;

const SHARED_CACHE_SETTINGS = JSON.stringify({ skipCidCache: true, skipArchiveCache: false, skipWorkerCache: false });

interface FakeChannel extends SharedChannel {
  read: ReturnType<typeof vi.fn<SharedChannel['read']>>;
  /** Lets the reads held so far answer. */
  open: () => void;
}

/** A shared store holding cache settings, whose reads wait until `open` is called. */
function fakeChannel(): FakeChannel {
  let open!: () => void;
  const gate = new Promise<void>(resolve => {
    open = resolve;
  });
  const store = new Map<string, string>([['dotli:cache-settings', SHARED_CACHE_SETTINGS]]);
  return {
    read: vi.fn<SharedChannel['read']>(async key => {
      await gate;
      return store.get(key) ?? null;
    }),
    write: vi.fn<SharedChannel['write']>(() => Promise.resolve()),
    clear: vi.fn<SharedChannel['clear']>(() => Promise.resolve()),
    open,
  };
}

/** A bootstrap of its own, with the functions that read the mode storage it configures. */
function load() {
  return {
    bootstrapSharedMode: createSharedModeBootstrap(local),
    getCacheSettings,
    getNetwork,
    persistDefaults,
    setNetwork,
  };
}

/** A bootstrap of its own with a fake Sentry and capture sink bound for this test. */
function loadReporting() {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  return { ...load(), counted: metrics.counted, captures };
}

beforeEach(() => {
  // The mode storage is the config package's page state, so each test starts from the per-origin path.
  local = memoryStorage();
  configureModeStorage(local);
});

describe('bootstrapSharedMode', () => {
  it('As a page that bootstraps twice at once, the second call returns once the shared settings apply', async () => {
    // Given
    const { bootstrapSharedMode, getCacheSettings } = load();
    const channel = fakeChannel();
    const first = bootstrapSharedMode(channel);

    // When
    const second = bootstrapSharedMode(channel);
    channel.open();
    await second;

    // Then
    expect(getCacheSettings().skipCidCache).toBe(true);
    await first;
    expect(channel.read).toHaveBeenCalledTimes(2);
  });

  it('As a page whose first shared read failed, I pick up the shared settings on the next bootstrap', async () => {
    // Given: a shared store that is down for the first bootstrap
    const { bootstrapSharedMode, getCacheSettings } = load();
    const channel = fakeChannel();
    channel.open();
    channel.read.mockRejectedValueOnce(new Error('host frame unavailable'));
    await bootstrapSharedMode(channel);
    expect(getCacheSettings().skipCidCache).toBe(false);

    // When
    await bootstrapSharedMode(channel);

    // Then
    expect(getCacheSettings().skipCidCache).toBe(true);
  });

  it('As a page that bootstraps twice while the first read fails, the queued call reads again and applies the settings', async () => {
    // Given
    const { bootstrapSharedMode, getCacheSettings } = load();
    const channel = fakeChannel();
    channel.read.mockRejectedValueOnce(new Error('host frame unavailable'));

    // When
    const bootstraps = Promise.all([bootstrapSharedMode(channel), bootstrapSharedMode(channel)]);
    channel.open();
    await bootstraps;

    // Then
    expect(channel.read).toHaveBeenCalledTimes(4);
    expect(getCacheSettings().skipCidCache).toBe(true);
  });

  it('As a page that is already bootstrapped, I do not read the shared store again', async () => {
    // Given
    const { bootstrapSharedMode } = load();
    const channel = fakeChannel();
    channel.open();
    await bootstrapSharedMode(channel);

    // When
    await bootstrapSharedMode(channel);

    // Then
    expect(channel.read).toHaveBeenCalledTimes(2);
  });

  it('As a first-time visitor, bootstrapping the shared settings stores no default on this origin', async () => {
    // Given
    const { bootstrapSharedMode } = load();
    const channel = fakeChannel();
    channel.open();

    // When
    await bootstrapSharedMode(channel);

    // Then
    expect(local.getItem('dotli:chain-backend')).toBeNull();
    expect(channel.write).not.toHaveBeenCalled();
  });

  it('As a first-time visitor, I boot with the stored defaults and the backend mirrors up to the shared store', async () => {
    // Given a fresh origin whose boot stored the defaults first
    const { bootstrapSharedMode, getNetwork, persistDefaults } = load();
    const channel = fakeChannel();
    channel.open();
    persistDefaults(false);

    // When
    await bootstrapSharedMode(channel);

    // Then the backend is shared, and the network stays on this origin
    expect(channel.write).toHaveBeenCalledWith('dotli:chain-backend', 'smoldot-direct');
    expect(channel.write).not.toHaveBeenCalledWith('dotli:network', expect.anything());
    expect(getNetwork()).toBe('paseo-next-v2');
    expect(local.getItem('dotli:network')).toBe('paseo-next-v2');
  });

  it('As a visitor, my network choice stays on this origin once the shared settings apply', async () => {
    // Given
    const { bootstrapSharedMode, getNetwork, setNetwork } = load();
    const channel = fakeChannel();
    channel.open();
    await bootstrapSharedMode(channel);

    // When
    setNetwork('previewnet');

    // Then
    expect(getNetwork()).toBe('previewnet');
    expect(local.getItem('dotli:network')).toBe('previewnet');
    expect(channel.write).not.toHaveBeenCalled();
  });

  it('As an operator, I see a failed shared mode read reported with its error name', async () => {
    // Given
    const { bootstrapSharedMode, counted, captures } = loadReporting();
    const channel = fakeChannel();
    channel.open();
    const timeout = new Error('Protocol request "modeStorageRead" timed out after 30000ms');
    timeout.name = 'ProtocolTimeoutError';
    channel.read.mockRejectedValueOnce(timeout);

    // When
    await bootstrapSharedMode(channel);

    // Then
    expect(captures.exception).toHaveBeenCalledWith(timeout, { flow: 'boot', step: 'shared_mode_read' });
    expect(counted('shared_mode.read')).toContainEqual({ outcome: 'error', reason: 'ProtocolTimeoutError' });
  });

  it('As an operator, I see a shared mode read that answered counted as ok', async () => {
    // Given
    const { bootstrapSharedMode, counted, captures } = loadReporting();
    const channel = fakeChannel();
    channel.open();

    // When
    await bootstrapSharedMode(channel);

    // Then
    expect(counted('shared_mode.read')).toContainEqual({ outcome: 'ok' });
    expect(captures.exception).not.toHaveBeenCalled();
  });
});
