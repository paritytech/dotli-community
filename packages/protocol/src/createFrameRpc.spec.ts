// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, expectTypeOf, it, onTestFinished } from 'vitest';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import { catchRejection, createManualTimers, type ManualTimers } from '@dotli/shared/testing';
import { denied, domain, err, malformedFrame, ok, unsupported, type Request } from '@dotli/transport';
import { getCallName } from './methodPolicy.js';
import { PROTOCOL_ERRORS } from './errors.js';
import { createFrameRpc } from './createFrameRpc.js';
import { createFakeFrame, type FakeFrame } from './createProtocolFrame.fake.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';

const { resolve, storage, wallet } = protocolSchema.sections;

/** The metrics Sentry receives, recorded for each test. */
let metrics: RecordingSentry;
/** The clock and timers each test moves by hand. */
let timers: ManualTimers;

function settle(): Promise<void> {
  return timers.advance(0);
}

/** A frame app that takes the store read and owner calls and never answers them, recording what it was asked. */
function createSilentFrame(served: string[]): (serving: ProtocolTransport) => void {
  return serving => {
    function hold<P, R, E>(method: Request<P, R, E>): void {
      serving.handleRequest(method, () => {
        served.push(getCallName(method));
        return new Promise(() => undefined);
      });
    }
    hold(storage.authRead);
    hold(storage.modeWrite);
    hold(wallet.read);
    hold(resolve.owner);
  };
}

describe('createFrameRpc', () => {
  it('As a dotli integrator, I make a request and it resolves with the type its method answers, so no caller casts', () => {
    // Given
    const rpc = createFrameRpc({ frame: createFakeFrame({ timers }).frame, timers });

    // When
    const resolveOwner = () => rpc.request(resolve.owner, { label: 'doom' });
    const readWallet = () => rpc.request(wallet.read, { siteId: 'dot.li' });

    // Then
    expectTypeOf(resolveOwner).returns.resolves.toEqualTypeOf<string | null>();
    expectTypeOf(readWallet).returns.resolves.toEqualTypeOf<
      | { tag: 'none'; value: undefined }
      | { tag: 'unreadable'; value: undefined }
      | {
          tag: 'ok';
          value: {
            entropy: Uint8Array;
            identity: { identityAccountId: string; liteUsername: string | null } | null;
            version: Uint8Array;
          };
        }
    >();
  });

  beforeEach(() => {
    timers = createManualTimers();
    metrics = bindRecordingSentry({ onFinished: onTestFinished });
  });

  it('As a dotli integrator, I make a shared store request and it waits only for a listening frame, while any other waits for a ready one', async () => {
    // Given a frame still booting, with a shared store request and another waiting on it
    const served: string[] = [];
    const fake = createFakeFrame({ serve: createSilentFrame(served), status: 'booting', timers });
    const rpc = createFrameRpc({ frame: fake.frame, timers });
    void rpc.request(storage.authRead, { siteId: 'dotli', key: 'k' });
    void rpc.request(resolve.owner, { label: 'doom' });

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

  it('As a dotli integrator, I read a failed answer under the name it crossed with, and a bare Error as a protocol response error', async () => {
    // Given
    class DotNsError extends Error {
      override name = 'DotNsError';
    }
    const fake = createFakeFrame({
      serve: serving => {
        serving.handleRequest(resolve.owner, ({ label }) => {
          throw label === 'a' ? new DotNsError('no') : new Error('no');
        });
      },
      timers,
    });
    const rpc = createFrameRpc({ frame: fake.frame, timers });

    // When
    const named = catchRejection(rpc.request(resolve.owner, { label: 'a' }));
    const bare = catchRejection(rpc.request(resolve.owner, { label: 'b' }));
    await settle();

    // Then
    expect(await named).toMatchObject({ name: 'DotNsError', message: 'no', method: 'resolveOwner' });
    expect(await bare).toMatchObject({ name: 'ProtocolResponseError', message: 'no', method: 'resolveOwner' });
  });

  it('As the host, I see a resolver sync timeout in the frame on my error screen as NetworkSyncTimeoutError', async () => {
    // Given a frame whose resolver ran out of sync time, and one whose light client stopped
    const fake = createFakeFrame({
      serve: serving => {
        serving.handleRequest(resolve.owner, ({ label }) =>
          err(
            domain(
              label === 'slow'
                ? { tag: 'syncTimeout' as const, value: 'Sync to Asset Hub Paseo timed out after 45s' }
                : { tag: 'apiStopped' as const, value: 'stopped' },
            ),
          ),
        );
      },
      timers,
    });
    const rpc = createFrameRpc({ frame: fake.frame, timers });

    // When
    const slow = catchRejection(rpc.request(resolve.owner, { label: 'slow' }));
    const stopped = catchRejection(rpc.request(resolve.owner, { label: 'gone' }));
    await settle();

    // Then the error screen matches on the name and reads the message
    expect(await slow).toMatchObject({
      name: 'NetworkSyncTimeoutError',
      message: 'Sync to Asset Hub Paseo timed out after 45s',
      method: 'resolveOwner',
    });
    expect(await stopped).toMatchObject({ name: 'ApiStoppedError', message: 'stopped' });
    expect(metrics.counted('protocol.request')).toEqual([
      { outcome: 'error', method: 'resolveOwner', reason: 'NetworkSyncTimeoutError' },
      { outcome: 'error', method: 'resolveOwner', reason: 'ApiStoppedError' },
    ]);
  });

  it('As a dotli integrator, I make calls the frame refuses, lacks or cannot read and each fails named after why', async () => {
    // Given a frame that refuses the auth read, cannot read the mode write, and serves no wallet read
    const fake = createFakeFrame({
      serve: serving => {
        serving.handleRequest(storage.authRead, () => err(denied()));
        serving.handleRequest(storage.modeWrite, () => err(malformedFrame('a key is missing')));
        serving.handleRequest(storage.modeRead, () => err(unsupported()));
      },
      timers,
    });
    const rpc = createFrameRpc({ frame: fake.frame, timers });

    // When
    const failures = [
      catchRejection(rpc.request(storage.authRead, { siteId: 'dotli', key: 'k' })),
      catchRejection(rpc.request(storage.modeWrite, { siteId: 'dotli', key: 'k', value: 'v' })),
      catchRejection(rpc.request(storage.modeRead, { siteId: 'dotli', key: 'k' })),
      catchRejection(rpc.request(wallet.read, { siteId: 'dotli' })),
    ];
    await settle();

    // Then
    expect(await Promise.all(failures)).toEqual([
      expect.objectContaining({ name: 'Denied', method: 'authStorageRead' }),
      expect.objectContaining({ name: 'MalformedFrame', message: 'a key is missing', method: 'modeStorageWrite' }),
      expect.objectContaining({ name: 'Unsupported', method: 'modeStorageRead' }),
      expect.objectContaining({ name: 'Unsupported', method: 'localWalletRead' }),
    ]);
    const counted = metrics.counted('protocol.request');
    expect(counted.sort((a, b) => String(a?.['method']).localeCompare(String(b?.['method'])))).toEqual([
      { outcome: 'error', method: 'authStorageRead', reason: 'Denied' },
      { outcome: 'error', method: 'localWalletRead', reason: 'Unsupported' },
      { outcome: 'error', method: 'modeStorageRead', reason: 'Unsupported' },
      { outcome: 'error', method: 'modeStorageWrite', reason: 'MalformedFrame' },
    ]);
  });

  it('As a dotli integrator, I lose the frame under a request still out and the request fails at once with why', async () => {
    // Given
    const fake = createFakeFrame({ serve: createSilentFrame([]), timers });
    const rpc = createFrameRpc({ frame: fake.frame, timers });
    const read = rpc.request(storage.authRead, { siteId: 'dotli', key: 'k' });
    await settle();

    // When
    fake.lose(new Error('boom'));

    // Then
    await expect(read).rejects.toThrow('boom');
  });

  it.each([
    {
      status: 'idle',
      goDown: (fake: FakeFrame): void => {
        fake.setStatus('idle');
      },
      reason: 'frame went idle',
    },
    {
      status: 'failed',
      goDown: (fake: FakeFrame): void => {
        fake.lose(new Error('frame lost'));
      },
      reason: 'frame lost',
    },
  ])(
    'As a dotli integrator, I see a request waiting on a frame that goes $status and fails instead of waiting forever',
    async ({ goDown, reason }) => {
      // Given a frame still booting
      const served: string[] = [];
      const fake = createFakeFrame({ serve: createSilentFrame(served), status: 'booting', timers });
      const rpc = createFrameRpc({ frame: fake.frame, timers });
      const request = rpc.request(resolve.owner, { label: 'doom' });

      // When
      goDown(fake);

      // Then
      await expect(request).rejects.toThrow(reason);
      expect(served).toEqual([]);
    },
  );

  it('As a dotli integrator, I make a request whose frame is dropped in the same turn and it fails with why, is never served, and is not counted as a timeout', async () => {
    // Given
    const served: string[] = [];
    const fake = createFakeFrame({ serve: createSilentFrame(served), timers });
    const rpc = createFrameRpc({ frame: fake.frame, timers });
    const write = catchRejection(rpc.request(storage.modeWrite, { siteId: 'dotli', key: 'k', value: 'v' }));

    // When the frame is dropped before the write goes out
    fake.lose(new Error(PROTOCOL_ERRORS.FRAME_RESET));
    await timers.advance(30_000);

    // Then
    expect((await write).message).toBe(PROTOCOL_ERRORS.FRAME_RESET);
    expect(served).toEqual([]);
    expect(metrics.counted('protocol.request')).not.toContainEqual(expect.objectContaining({ outcome: 'timeout' }));
  });

  it('As a dotli integrator, I make a request the frame never answers and it times out on its budget and is counted', async () => {
    // Given
    const fake = createFakeFrame({ serve: createSilentFrame([]), timers });
    const rpc = createFrameRpc({ frame: fake.frame, timers });
    const read = catchRejection(rpc.request(storage.authRead, { siteId: 'dotli', key: 'k' }));
    await settle();

    // When
    await timers.advance(30_000);

    // Then
    expect((await read).name).toBe('ProtocolTimeoutError');
    expect(metrics.counted('protocol.request')).toContainEqual({
      outcome: 'timeout',
      method: 'authStorageRead',
      reason: 'ProtocolTimeoutError',
    });
  });

  it('As a dotli integrator, I make a shared store request the frame never answers and the frame is asked whether it still answers', async () => {
    // Given
    const fake = createFakeFrame({ serve: createSilentFrame([]), timers });
    const rpc = createFrameRpc({ frame: fake.frame, timers });
    const transport = await fake.frame.getTransport();
    const read = catchRejection(rpc.request(storage.authRead, { siteId: 'dotli', key: 'k' }));
    await settle();

    // When
    await timers.advance(30_000);

    // Then
    expect((await read).name).toBe('ProtocolTimeoutError');
    expect(fake.checks).toHaveLength(1);
    expect(fake.checks[0]).toBe(transport);
  });

  it('As a dotli integrator, I make a chain request that times out and the frame is not checked', async () => {
    // Given
    const fake = createFakeFrame({ serve: createSilentFrame([]), timers });
    const rpc = createFrameRpc({ frame: fake.frame, timers });
    const owner = catchRejection(rpc.request(resolve.owner, { label: 'doom' }));
    await settle();

    // When
    await timers.advance(90_000);

    // Then
    expect((await owner).name).toBe('ProtocolTimeoutError');
    expect(fake.checks).toEqual([]);
  });

  it('As a dotli integrator, I make a shared store request whose budget runs out before the frame listens and the frame is not checked', async () => {
    // Given a frame that stays booting
    const fake = createFakeFrame({ serve: createSilentFrame([]), status: 'booting', timers });
    const rpc = createFrameRpc({ frame: fake.frame, timers });
    const read = catchRejection(rpc.request(storage.authRead, { siteId: 'dotli', key: 'k' }));

    // When
    await timers.advance(30_000);

    // Then
    expect((await read).name).toBe('ProtocolTimeoutError');
    expect(fake.checks).toEqual([]);
  });

  it('As a dotli integrator, I make a chain request while the frame comes up and its budget starts only once the frame is up', async () => {
    // Given a frame still coming up, with a request made 10 s before it is ready
    const fake = createFakeFrame({ serve: createSilentFrame([]), status: 'booting', timers });
    const rpc = createFrameRpc({ frame: fake.frame, timers });
    let settled = false;
    const owner = catchRejection(rpc.request(resolve.owner, { label: 'doom' })).finally(() => {
      settled = true;
    });
    await timers.advance(10_000);
    fake.setStatus('ready');
    await settle();

    // When
    await timers.advance(89_999);
    const settledBeforeBudget = settled;
    await timers.advance(1);

    // Then
    expect(settledBeforeBudget).toBe(false);
    expect((await owner).name).toBe('ProtocolTimeoutError');
  });

  it('As the host booting, I read the wallet while the frame never loads and the read fails on its budget, never served', async () => {
    // Given a frame that stays booting
    const served: string[] = [];
    const fake = createFakeFrame({ serve: createSilentFrame(served), status: 'booting', timers });
    const rpc = createFrameRpc({ frame: fake.frame, timers });
    const read = catchRejection(rpc.request(wallet.read, { siteId: 'dotli' }));

    // When
    await timers.advance(5_000);

    // Then
    expect((await read).name).toBe('ProtocolTimeoutError');
    expect(served).toEqual([]);
    expect(metrics.counted('protocol.request')).toContainEqual({
      outcome: 'timeout',
      method: 'localWalletRead',
      reason: 'ProtocolTimeoutError',
    });
  });

  it('As the host booting, I make a shared store call and it is timed from when it goes out after the handshake, not from the boot', async () => {
    // Given a wallet read made while the frame boots, on a frame that answers at once
    const fake = createFakeFrame({
      serve: serving => {
        serving.handleRequest(wallet.read, () => ok({ tag: 'none' as const, value: undefined }));
      },
      status: 'booting',
      timers,
    });
    const rpc = createFrameRpc({ frame: fake.frame, timers, now: () => timers.now() });
    const read = rpc.request(wallet.read, { siteId: 'dotli' });

    // When the frame listens 3 s later
    await timers.advance(3_000);
    fake.setStatus('listening');
    await settle();

    // Then
    await expect(read).resolves.toEqual({ tag: 'none', value: undefined });
    expect(
      metrics.distributions.filter(metric => metric.name === 'dotli.protocol.request').map(metric => metric.value),
    ).toEqual([0]);
  });

  it('As a dotli integrator, I give a request a clock and it is timed on that clock, apart from the timers its budget runs on', async () => {
    // Given a frame that answers once the test says, and a clock apart from the timers
    const answer = createDeferred<string | null>();
    const fake = createFakeFrame({
      serve: serving => {
        serving.handleRequest(resolve.owner, () => answer.promise.then(value => ok(value)));
      },
      timers,
    });
    let clock = 0;
    const rpc = createFrameRpc({ frame: fake.frame, timers, now: () => clock });
    const owner = rpc.request(resolve.owner, { label: 'doom' });
    await settle();

    // When the clock moves 40 ms and the timers 5 s before the answer
    clock = 40;
    await timers.advance(5_000);
    answer.resolve('5Grw');
    await settle();

    // Then
    await expect(owner).resolves.toBe('5Grw');
    expect(
      metrics.distributions.filter(metric => metric.name === 'dotli.protocol.request').map(metric => metric.value),
    ).toEqual([40]);
  });

  it('As the host booting, I queue shared store calls on a frame whose boot fails and they fail with why and count nothing', async () => {
    // Given two shared store calls made while the frame boots
    const fake = createFakeFrame({ serve: createSilentFrame([]), status: 'booting', timers });
    const rpc = createFrameRpc({ frame: fake.frame, timers });
    const read = catchRejection(rpc.request(storage.authRead, { siteId: 'dotli', key: 'k' }));
    const write = catchRejection(rpc.request(storage.modeWrite, { siteId: 'dotli', key: 'k', value: 'v' }));
    await settle();

    // When the boot fails
    fake.lose(new Error('boot failed'));
    await settle();

    // Then the frame counts its own boot failure, so the calls add nothing
    expect((await read).message).toBe('boot failed');
    expect((await write).message).toBe('boot failed');
    expect(metrics.counted('protocol.request')).toEqual([]);
    expect(metrics.distributions.filter(metric => metric.name === 'dotli.protocol.request')).toEqual([]);
  });

  it('As the host booting, I read the wallet and the read keeps only what the wait for the frame left of its budget', async () => {
    // Given a wallet read made while the frame boots, which listens 3 s later
    const served: string[] = [];
    const fake = createFakeFrame({ serve: createSilentFrame(served), status: 'booting', timers });
    const rpc = createFrameRpc({ frame: fake.frame, timers });
    let settled = false;
    const read = catchRejection(rpc.request(wallet.read, { siteId: 'dotli' })).finally(() => {
      settled = true;
    });
    await timers.advance(3_000);
    fake.setStatus('listening');
    await settle();

    // When the frame never answers
    await timers.advance(1_999);
    const settledBeforeBudget = settled;
    await timers.advance(1);

    // Then it reached the frame, and fails 5 s after it was made
    expect(served).toEqual(['localWalletRead']);
    expect(settledBeforeBudget).toBe(false);
    expect((await read).name).toBe('ProtocolTimeoutError');
  });
});
