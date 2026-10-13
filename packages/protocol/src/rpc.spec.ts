// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { PROTOCOL_ERRORS } from './errors.js';
import type { LocalWalletReadResult, ProtocolEnvelope } from './messages.js';
import { createFrameRpc } from './rpc.js';
import { createFakeFrame } from './frame.fake.js';

/** Lets the request's wait for the frame settle, so it is posted. */
const posted = async (): Promise<void> => {
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

describe('createFrameRpc', () => {
  it('As a dotli integrator, a request resolves with the type its method answers, so no caller casts', () => {
    // Given
    const rpc = createFrameRpc(createFakeFrame().frame);

    // When
    const resolveName = () => rpc.request('resolveDotName', { label: 'doom' });
    const readWallet = () => rpc.request('localWalletRead', { siteId: 'dot.li' });

    // Then
    expectTypeOf(resolveName).returns.resolves.toEqualTypeOf<string | null>();
    expectTypeOf(readWallet).returns.resolves.toEqualTypeOf<LocalWalletReadResult>();
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
    // Given
    const fake = createFakeFrame();
    const rpc = createFrameRpc(fake.frame);

    // When
    void rpc.request('authStorageRead', { siteId: 'dotli', key: 'k' });
    void rpc.request('resolveOwner', { label: 'doom' });
    await posted();

    // Then
    expect(fake.waits).toEqual(['listening', 'ready']);
    expect(fake.posted.map(envelope => envelope.method)).toEqual(['authStorageRead', 'resolveOwner']);
  });

  it('As a dotli integrator, an answer settles its own request, and progress reaches it before', async () => {
    // Given
    const fake = createFakeFrame();
    const rpc = createFrameRpc(fake.frame);
    const progress: string[] = [];
    const resolved = rpc.request('resolveDotName', { label: 'doom' }, phase => progress.push(phase));
    await posted();
    const id = fake.posted[0]?.id ?? '';

    // When
    fake.send({ namespace: 'dotli:protocol', kind: 'progress', id, phase: 'asset-hub-syncing' });
    fake.send({ namespace: 'dotli:protocol', kind: 'response', id: 'someone-else', ok: true, result: 'nope' });
    fake.send({ namespace: 'dotli:protocol', kind: 'response', id, ok: true, result: '0xcid' });

    // Then
    await expect(resolved).resolves.toBe('0xcid');
    expect(progress).toEqual(['asset-hub-syncing']);
  });

  it('As a dotli integrator, a progress whose phase the resolver never reports does not reach the request', async () => {
    // Given
    const fake = createFakeFrame();
    const rpc = createFrameRpc(fake.frame);
    const progress: string[] = [];
    const resolved = rpc.request('resolveDotName', { label: 'doom' }, phase => progress.push(phase));
    await posted();
    const id = fake.posted[0]?.id ?? '';

    // When
    fake.send({
      namespace: 'dotli:protocol',
      kind: 'progress',
      id,
      phase: 'Syncing #42',
    } as unknown as ProtocolEnvelope);
    fake.send({ namespace: 'dotli:protocol', kind: 'response', id, ok: true, result: '0xcid' });

    // Then
    await expect(resolved).resolves.toBe('0xcid');
    expect(progress).toEqual([]);
  });

  it('As a dotli integrator, a failed answer keeps the name it crossed with, and a bare Error becomes a protocol response error', async () => {
    // Given
    const fake = createFakeFrame();
    const rpc = createFrameRpc(fake.frame);
    const named = failure(rpc.request('resolveOwner', { label: 'a' }));
    const bare = failure(rpc.request('resolveOwner', { label: 'b' }));
    await posted();

    // When
    const [first, second] = fake.posted;
    fake.send({
      namespace: 'dotli:protocol',
      kind: 'response',
      id: first?.id ?? '',
      ok: false,
      error: 'no',
      errorName: 'DotNsError',
    });
    fake.send({
      namespace: 'dotli:protocol',
      kind: 'response',
      id: second?.id ?? '',
      ok: false,
      error: 'no',
      errorName: 'Error',
    });

    // Then
    expect((await named).name).toBe('DotNsError');
    expect((await bare).name).toBe('ProtocolResponseError');
  });

  it('As a dotli integrator, a request still out when the frame is lost fails at once with why', async () => {
    // Given
    const fake = createFakeFrame();
    const rpc = createFrameRpc(fake.frame);
    const read = rpc.request('authStorageRead', { siteId: 'dotli', key: 'k' });
    await posted();

    // When
    fake.lose(new Error('Fatal: boom'));

    // Then
    await expect(read).rejects.toThrow('Fatal: boom');
  });

  it('As a dotli integrator, a request whose frame vanished before the post fails with why, and leaves no timer or count behind', async () => {
    // Given
    const fake = createFakeFrame();
    fake.frame.post = () => {
      throw new Error(PROTOCOL_ERRORS.FRAME_UNAVAILABLE);
    };
    const rpc = createFrameRpc(fake.frame);

    // When
    const read = failure(rpc.request('authStorageRead', { siteId: 'dotli', key: 'k' }));

    // Then
    expect((await read).message).toBe(PROTOCOL_ERRORS.FRAME_UNAVAILABLE);
    expect(vi.getTimerCount()).toBe(0);
    expect(metrics.counts).toEqual([]);
  });

  it('As a dotli integrator, a request the frame never answers times out on its budget and is counted', async () => {
    // Given
    const fake = createFakeFrame();
    const rpc = createFrameRpc(fake.frame);
    const read = failure(rpc.request('authStorageRead', { siteId: 'dotli', key: 'k' }));
    await posted();

    // When
    await vi.advanceTimersByTimeAsync(30_000);

    // Then
    expect((await read).name).toBe('ProtocolTimeoutError');
    expect(metrics.counted(S.PROTOCOL_REQUEST)).toContainEqual({ outcome: 'timeout', method: 'authStorageRead' });
  });

  it('As a dotli integrator, I send a request while the frame comes up and its timer starts only once the frame is up', async () => {
    // Given a frame still coming up
    const fake = createFakeFrame();
    let comeUp: () => void = () => undefined;
    fake.frame.whenUp = () =>
      new Promise<void>(resolve => {
        comeUp = resolve;
      });
    const rpc = createFrameRpc(fake.frame);

    // When a request is made, and the frame then comes up
    void rpc.request('authStorageRead', { siteId: 'dotli', key: 'k' });
    await posted();
    const timersWhileWaiting = vi.getTimerCount();
    const postedWhileWaiting = fake.posted.length;
    comeUp();
    await posted();

    // Then nothing was posted or timed while it waited, and the budget starts once the request is posted
    expect(timersWhileWaiting).toBe(0);
    expect(postedWhileWaiting).toBe(0);
    expect(fake.posted.map(envelope => envelope.method)).toEqual(['authStorageRead']);
    expect(vi.getTimerCount()).toBe(1);
  });
});
