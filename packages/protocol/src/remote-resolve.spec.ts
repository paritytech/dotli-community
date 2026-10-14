// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteResolve } from './remote-resolve.js';
import { createFrameRpc } from './rpc.js';
import { createFakeFrame } from './frame.fake.js';

describe('createRemoteResolve', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("As a dotli user, my product's name is resolved by the frame's light client, and its phases reach me", async () => {
    // Given
    vi.useFakeTimers();
    const fake = createFakeFrame();
    const resolve = createRemoteResolve(createFrameRpc(fake.frame));
    const progress: string[] = [];
    const cid = resolve.resolveDotNameRemote('doom', phase => progress.push(phase));
    await vi.advanceTimersByTimeAsync(0);
    const request = fake.posted[0];

    // When
    fake.send({ namespace: 'dotli:protocol', kind: 'progress', id: request?.id ?? '', phase: 'asset-hub-syncing' });
    fake.send({ namespace: 'dotli:protocol', kind: 'response', id: request?.id ?? '', ok: true, result: '0xcid' });

    // Then
    await expect(cid).resolves.toBe('0xcid');
    expect(request?.method).toBe('resolveDotName');
    expect(request?.payload).toEqual({ label: 'doom' });
    expect(progress).toEqual(['asset-hub-syncing']);
  });
});
