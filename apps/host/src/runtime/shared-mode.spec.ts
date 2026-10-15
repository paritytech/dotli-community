// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { readSharedSettings, writeSharedSettings } from './shared-mode.js';
import { memorySharedChannel } from './shared-mode.fake.js';

const CACHE = JSON.stringify({ skipCidCache: true, skipArchiveCache: false, skipWorkerCache: false });

describe('readSharedSettings', () => {
  it('As a visitor on a new subdomain, I read the backend and caches I chose elsewhere, and the read is counted', async () => {
    // Given
    const { counted } = bindRecordingSentry({ onFinished: onTestFinished });
    const store = memorySharedChannel({ 'dotli:chain-backend': 'rpc-gateway', 'dotli:cache-settings': CACHE });

    // When
    const shared = await readSharedSettings(store);

    // Then
    expect(shared).toEqual({ backend: 'rpc-gateway', cache: CACHE });
    expect(counted('shared_mode.read')).toEqual([{ outcome: 'ok' }]);
  });

  it('As an operator, a shared store that cannot be read is reported and counted, and the boot gets nothing from it', async () => {
    // Given
    const store = memorySharedChannel();
    store.readFails = true;
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const { counted } = bindRecordingSentry({ onFinished: onTestFinished });

    // When
    const shared = await readSharedSettings(store);

    // Then
    expect(shared).toBeNull();
    expect(captures.exception).toHaveBeenCalledWith(expect.objectContaining({ message: 'shared store unreachable' }), {
      flow: 'boot',
      step: 'shared_mode_read',
    });
    expect(counted('shared_mode.read')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });
});

describe('writeSharedSettings', () => {
  it('As a visitor, my backend and caches are mirrored for my other subdomains', async () => {
    // Given
    const store = memorySharedChannel();

    // When
    await writeSharedSettings({ backend: 'rpc-gateway', cache: CACHE }, store);

    // Then
    expect(store.writes).toEqual([
      ['dotli:chain-backend', 'rpc-gateway'],
      ['dotli:cache-settings', CACHE],
    ]);
  });

  it('As an operator, a shared setting that cannot be written is reported and counted, and the save still settles', async () => {
    // Given
    const store = memorySharedChannel();
    store.writeFails = true;
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const { counted } = bindRecordingSentry({ onFinished: onTestFinished });

    // When
    await writeSharedSettings({ backend: 'rpc-gateway', cache: null }, store);

    // Then
    expect(captures.exception).toHaveBeenCalledWith(expect.objectContaining({ message: 'shared store unreachable' }), {
      flow: 'storage',
      step: 'shared_mode_write',
    });
    expect(counted('shared_mode.write')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });
});
