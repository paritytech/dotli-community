// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { PROTOCOL_ERRORS } from './errors.js';
import type { Answer } from './methods.js';
import { createFrameRpc } from './rpc.js';
import { createFakeFrame } from './frame.fake.js';
import type { CallContext, ServingTransport } from './transport-serving.js';

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** The metrics Sentry receives, recorded for each test. */
let metrics: RecordingSentry;

/** The error a request failed with. */
function failure(request: Promise<unknown>): Promise<Error> {
  return request.then(
    () => {
      throw new Error('the request resolved');
    },
    (err: unknown) => err as Error,
  );
}

/** A frame app that takes the store read and owner calls and never answers them, recording what it was asked. */
function silentFrame(served: string[]): (serving: ServingTransport) => void {
  return serving => {
    const hold = <T>(method: string): Promise<T> => {
      served.push(method);
      return new Promise<T>(() => undefined);
    };
    serving.handleRequest('authStorageRead', () => hold<string | null>('authStorageRead'));
    serving.handleRequest('modeStorageWrite', () => hold<undefined>('modeStorageWrite'));
    serving.handleRequest('localWalletRead', () => hold<Answer<'localWalletRead'>>('localWalletRead'));
    serving.handleRequest('resolveOwner', () => hold<string | null>('resolveOwner'));
  };
}

describe('createFrameRpc', () => {
  it('As a dotli integrator, a request resolves with the type its method answers, so no caller casts', () => {
    // Given
    const rpc = createFrameRpc(createFakeFrame().frame);

    // When
    const resolveOwner = () => rpc.request('resolveOwner', { label: 'doom' });
    const readWallet = () => rpc.request('localWalletRead', { siteId: 'dot.li' });

    // Then
    expectTypeOf(resolveOwner).returns.resolves.toEqualTypeOf<string | null>();
    expectTypeOf(readWallet).returns.resolves.toEqualTypeOf<Answer<'localWalletRead'>>();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    metrics = bindRecordingSentry({ onFinished: onTestFinished });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('As a dotli integrator, a shared store request waits only for a listening frame, and any other for a ready one', async () => {
    // Given a frame still booting, with a shared store request and another waiting on it
    const served: string[] = [];
    const fake = createFakeFrame(silentFrame(served), { status: 'booting' });
    const rpc = createFrameRpc(fake.frame);
    void rpc.request('authStorageRead', { siteId: 'dotli', key: 'k' });
    void rpc.request('resolveOwner', { label: 'doom' });

    // When the frame listens
    fake.setStatus('listening');
    await settle();

    // Then only the shared store request reaches it
    expect(served).toEqual(['authStorageRead']);

    // When the frame is ready
    fake.setStatus('ready');
    await settle();

    // Then the other follows
    expect(served).toEqual(['authStorageRead', 'resolveOwner']);
  });

  it('As a dotli integrator, a request resolves with what the frame answers, and the frame reads its deadline', async () => {
    // Given
    const contexts: CallContext[] = [];
    const fake = createFakeFrame(serving => {
      serving.handleRequest('resolveOwner', ({ label }, context) => {
        contexts.push(context);
        return label === 'doom' ? '5Grw' : null;
      });
    });
    const rpc = createFrameRpc(fake.frame);

    // When
    const owner = rpc.request('resolveOwner', { label: 'doom' });
    const askedAt = Date.now();
    await settle();

    // Then
    await expect(owner).resolves.toBe('5Grw');
    expect(contexts.map(context => context.deadlineMs)).toEqual([askedAt + 90_000]);
  });

  it('As a dotli integrator, a failed answer keeps the name it crossed with, and a bare Error becomes a protocol response error', async () => {
    // Given
    class DotNsError extends Error {
      override name = 'DotNsError';
    }
    const fake = createFakeFrame(serving => {
      serving.handleRequest('resolveOwner', ({ label }) => {
        throw label === 'a' ? new DotNsError('no') : new Error('no');
      });
    });
    const rpc = createFrameRpc(fake.frame);

    // When
    const named = failure(rpc.request('resolveOwner', { label: 'a' }));
    const bare = failure(rpc.request('resolveOwner', { label: 'b' }));
    await settle();

    // Then
    expect((await named).name).toBe('DotNsError');
    expect((await bare).name).toBe('ProtocolResponseError');
  });

  it('As a dotli integrator, a request still out when the frame is lost fails at once with why', async () => {
    // Given
    const fake = createFakeFrame(silentFrame([]));
    const rpc = createFrameRpc(fake.frame);
    const read = rpc.request('authStorageRead', { siteId: 'dotli', key: 'k' });
    await settle();

    // When
    fake.lose(new Error('boom'));

    // Then
    await expect(read).rejects.toThrow('boom');
  });

  it('As a dotli integrator, a request on an idle frame asks for the frame and goes out once it is ready', async () => {
    // Given a frame nobody has asked for yet
    const served: string[] = [];
    const fake = createFakeFrame(silentFrame(served), { status: 'idle' });
    const rpc = createFrameRpc(fake.frame);

    // When a request is made, and the frame then comes up
    void rpc.request('resolveOwner', { label: 'doom' });
    await settle();
    const statusWhileWaiting = fake.frame.getStatus();
    const servedWhileWaiting = [...served];
    fake.setStatus('ready');
    await settle();

    // Then the frame boots, and the request waits for it instead of failing
    expect(statusWhileWaiting).toBe('booting');
    expect(servedWhileWaiting).toEqual([]);
    expect(served).toEqual(['resolveOwner']);
  });

  it.each(['idle', 'failed'] as const)(
    'As a dotli integrator, a request waiting on a frame that goes %s fails instead of waiting forever',
    async down => {
      // Given a frame still booting
      const served: string[] = [];
      const fake = createFakeFrame(silentFrame(served), { status: 'booting' });
      const rpc = createFrameRpc(fake.frame);
      const request = rpc.request('resolveOwner', { label: 'doom' });

      // When
      if (down === 'failed') {
        fake.lose(new Error('frame lost'));
      } else {
        fake.setStatus('idle');
      }

      // Then
      await expect(request).rejects.toThrow(down === 'failed' ? 'frame lost' : 'frame went idle');
      expect(served).toEqual([]);
    },
  );

  it('As a dotli integrator, a request whose frame is dropped in the turn it is made fails with why, is never served, and is not counted as a timeout', async () => {
    // Given
    const served: string[] = [];
    const fake = createFakeFrame(silentFrame(served));
    const rpc = createFrameRpc(fake.frame);
    const write = failure(rpc.request('modeStorageWrite', { siteId: 'dotli', key: 'k', value: 'v' }));

    // When the frame is dropped before the write goes out
    fake.lose(new Error(PROTOCOL_ERRORS.FRAME_RESET));
    await vi.advanceTimersByTimeAsync(30_000);

    // Then
    expect((await write).message).toBe(PROTOCOL_ERRORS.FRAME_RESET);
    expect(served).toEqual([]);
    expect(metrics.counted(S.PROTOCOL_REQUEST)).not.toContainEqual(expect.objectContaining({ outcome: 'timeout' }));
  });

  it('As a dotli integrator, a request the frame never answers times out on its budget and is counted', async () => {
    // Given
    const fake = createFakeFrame(silentFrame([]));
    const rpc = createFrameRpc(fake.frame);
    const read = failure(rpc.request('authStorageRead', { siteId: 'dotli', key: 'k' }));
    await settle();

    // When
    await vi.advanceTimersByTimeAsync(30_000);

    // Then
    expect((await read).name).toBe('ProtocolTimeoutError');
    expect(metrics.counted(S.PROTOCOL_REQUEST)).toContainEqual({
      outcome: 'timeout',
      method: 'authStorageRead',
      reason: 'ProtocolTimeoutError',
    });
  });

  it('As a dotli integrator, I make a chain request while the frame comes up and its budget starts only once the frame is up', async () => {
    // Given a frame still coming up, with a request made 10 s before it is ready
    const fake = createFakeFrame(silentFrame([]), { status: 'booting' });
    const rpc = createFrameRpc(fake.frame);
    let settled = false;
    const owner = failure(rpc.request('resolveOwner', { label: 'doom' })).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    fake.setStatus('ready');
    await settle();

    // When
    await vi.advanceTimersByTimeAsync(89_999);
    const settledBeforeBudget = settled;
    await vi.advanceTimersByTimeAsync(1);

    // Then
    expect(settledBeforeBudget).toBe(false);
    expect((await owner).name).toBe('ProtocolTimeoutError');
  });

  it('As the host booting, my wallet read fails on its budget while the frame never loads, and is never served', async () => {
    // Given a frame that stays booting
    const served: string[] = [];
    const fake = createFakeFrame(silentFrame(served), { status: 'booting' });
    const rpc = createFrameRpc(fake.frame);
    const read = failure(rpc.request('localWalletRead', { siteId: 'dotli' }));

    // When
    await vi.advanceTimersByTimeAsync(5_000);

    // Then
    expect((await read).name).toBe('ProtocolTimeoutError');
    expect(served).toEqual([]);
    expect(metrics.counted(S.PROTOCOL_REQUEST)).toContainEqual({
      outcome: 'timeout',
      method: 'localWalletRead',
      reason: 'ProtocolTimeoutError',
    });
  });

  it('As the host booting, my wallet read keeps only what the wait for the frame left of its budget', async () => {
    // Given a wallet read made while the frame boots, which listens 3 s later
    const served: string[] = [];
    const fake = createFakeFrame(silentFrame(served), { status: 'booting' });
    const rpc = createFrameRpc(fake.frame);
    let settled = false;
    const read = failure(rpc.request('localWalletRead', { siteId: 'dotli' })).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    fake.setStatus('listening');
    await settle();

    // When the frame never answers
    await vi.advanceTimersByTimeAsync(1_999);
    const settledBeforeBudget = settled;
    await vi.advanceTimersByTimeAsync(1);

    // Then it reached the frame, and fails 5 s after it was made
    expect(served).toEqual(['localWalletRead']);
    expect(settledBeforeBudget).toBe(false);
    expect((await read).name).toBe('ProtocolTimeoutError');
  });
});
