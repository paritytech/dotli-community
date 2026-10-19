// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, expectTypeOf, it, onTestFinished } from 'vitest';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { deferred, toError } from '@dotli/shared';
import { manualTimers, type ManualTimers } from '@dotli/shared/testing';
import { denied, domain, err, malformedFrame, ok, unsupported, type Request } from '@dotli/transport';
import { callName } from './method-policy.js';
import { PROTOCOL_ERRORS } from './errors.js';
import { createFrameRpc } from './rpc.js';
import { createFakeFrame } from './frame.fake.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';

const { resolve, storage, wallet } = protocolSchema.sections;

/** The metrics Sentry receives, recorded for each test. */
let metrics: RecordingSentry;
/** The clock and timers each test moves by hand. */
let timers: ManualTimers;

const settle = (): Promise<void> => timers.advance(0);

/** The error a request failed with. */
function failure<T>(request: Promise<T>): Promise<Error> {
  return request.then(() => {
    throw new Error('the request resolved');
  }, toError);
}

/** A frame app that takes the store read and owner calls and never answers them, recording what it was asked. */
function silentFrame(served: string[]): (serving: ProtocolTransport) => void {
  return serving => {
    const hold = <P, R, E>(method: Request<P, R, E>): void => {
      serving.handleRequest(method, () => {
        served.push(callName(method));
        return new Promise(() => undefined);
      });
    };
    hold(storage.authRead);
    hold(storage.modeWrite);
    hold(wallet.read);
    hold(resolve.owner);
  };
}

describe('createFrameRpc', () => {
  it('As a dotli integrator, a request resolves with the type its method answers, so no caller casts', () => {
    // Given
    const rpc = createFrameRpc(createFakeFrame(undefined, { timers }).frame, timers);

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
          };
        }
    >();
  });

  beforeEach(() => {
    timers = manualTimers();
    metrics = bindRecordingSentry({ onFinished: onTestFinished });
  });

  it('As a dotli integrator, a shared store request waits only for a listening frame, and any other for a ready one', async () => {
    // Given a frame still booting, with a shared store request and another waiting on it
    const served: string[] = [];
    const fake = createFakeFrame(silentFrame(served), { status: 'booting', timers });
    const rpc = createFrameRpc(fake.frame, timers);
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

  it('As a dotli integrator, a request resolves with what the frame answers', async () => {
    // Given
    const fake = createFakeFrame(
      serving => {
        serving.handleRequest(resolve.owner, ({ label }) => ok(label === 'doom' ? '5Grw' : null));
      },
      { timers },
    );
    const rpc = createFrameRpc(fake.frame, timers);

    // When
    const owner = rpc.request(resolve.owner, { label: 'doom' });
    await settle();

    // Then
    await expect(owner).resolves.toBe('5Grw');
  });

  it('As a dotli integrator, a failed answer keeps the name it crossed with, and a bare Error becomes a protocol response error', async () => {
    // Given
    class DotNsError extends Error {
      override name = 'DotNsError';
    }
    const fake = createFakeFrame(
      serving => {
        serving.handleRequest(resolve.owner, ({ label }) => {
          throw label === 'a' ? new DotNsError('no') : new Error('no');
        });
      },
      { timers },
    );
    const rpc = createFrameRpc(fake.frame, timers);

    // When
    const named = failure(rpc.request(resolve.owner, { label: 'a' }));
    const bare = failure(rpc.request(resolve.owner, { label: 'b' }));
    await settle();

    // Then
    expect(await named).toMatchObject({ name: 'DotNsError', message: 'no', method: 'resolveOwner' });
    expect(await bare).toMatchObject({ name: 'ProtocolResponseError', message: 'no', method: 'resolveOwner' });
  });

  it('As the host, a resolver sync timeout in the frame reaches my error screen as NetworkSyncTimeoutError', async () => {
    // Given a frame whose resolver ran out of sync time, and one whose light client stopped
    const fake = createFakeFrame(
      serving => {
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
      { timers },
    );
    const rpc = createFrameRpc(fake.frame, timers);

    // When
    const slow = failure(rpc.request(resolve.owner, { label: 'slow' }));
    const stopped = failure(rpc.request(resolve.owner, { label: 'gone' }));
    await settle();

    // Then the error screen matches on the name and reads the message
    expect(await slow).toMatchObject({
      name: 'NetworkSyncTimeoutError',
      message: 'Sync to Asset Hub Paseo timed out after 45s',
      method: 'resolveOwner',
    });
    expect(await stopped).toMatchObject({ name: 'ApiStoppedError', message: 'stopped' });
    expect(metrics.counted(S.PROTOCOL_REQUEST)).toEqual([
      { outcome: 'error', method: 'resolveOwner', reason: 'NetworkSyncTimeoutError' },
      { outcome: 'error', method: 'resolveOwner', reason: 'ApiStoppedError' },
    ]);
  });

  it('As a dotli integrator, a call the frame refuses, lacks or cannot read fails named after why', async () => {
    // Given a frame that refuses the auth read, cannot read the mode write, and serves no wallet read
    const fake = createFakeFrame(
      serving => {
        serving.handleRequest(storage.authRead, () => err(denied()));
        serving.handleRequest(storage.modeWrite, () => err(malformedFrame('a key is missing')));
        serving.handleRequest(storage.modeRead, () => err(unsupported()));
      },
      { timers },
    );
    const rpc = createFrameRpc(fake.frame, timers);

    // When
    const failures = [
      failure(rpc.request(storage.authRead, { siteId: 'dotli', key: 'k' })),
      failure(rpc.request(storage.modeWrite, { siteId: 'dotli', key: 'k', value: 'v' })),
      failure(rpc.request(storage.modeRead, { siteId: 'dotli', key: 'k' })),
      failure(rpc.request(wallet.read, { siteId: 'dotli' })),
    ];
    await settle();

    // Then
    expect(await Promise.all(failures)).toEqual([
      expect.objectContaining({ name: 'Denied', method: 'authStorageRead' }),
      expect.objectContaining({ name: 'MalformedFrame', message: 'a key is missing', method: 'modeStorageWrite' }),
      expect.objectContaining({ name: 'Unsupported', method: 'modeStorageRead' }),
      expect.objectContaining({ name: 'Unsupported', method: 'localWalletRead' }),
    ]);
    const counted = metrics.counted(S.PROTOCOL_REQUEST);
    expect(counted.sort((a, b) => String(a?.['method']).localeCompare(String(b?.['method'])))).toEqual([
      { outcome: 'error', method: 'authStorageRead', reason: 'Denied' },
      { outcome: 'error', method: 'localWalletRead', reason: 'Unsupported' },
      { outcome: 'error', method: 'modeStorageRead', reason: 'Unsupported' },
      { outcome: 'error', method: 'modeStorageWrite', reason: 'MalformedFrame' },
    ]);
  });

  it('As a dotli integrator, a request still out when the frame is lost fails at once with why', async () => {
    // Given
    const fake = createFakeFrame(silentFrame([]), { timers });
    const rpc = createFrameRpc(fake.frame, timers);
    const read = rpc.request(storage.authRead, { siteId: 'dotli', key: 'k' });
    await settle();

    // When
    fake.lose(new Error('boom'));

    // Then
    await expect(read).rejects.toThrow('boom');
  });

  it('As a dotli integrator, a request on an idle frame asks for the frame and goes out once it is ready', async () => {
    // Given a frame nobody has asked for yet
    const served: string[] = [];
    const fake = createFakeFrame(silentFrame(served), { status: 'idle', timers });
    const rpc = createFrameRpc(fake.frame, timers);

    // When a request is made, and the frame then comes up
    void rpc.request(resolve.owner, { label: 'doom' });
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
      const fake = createFakeFrame(silentFrame(served), { status: 'booting', timers });
      const rpc = createFrameRpc(fake.frame, timers);
      const request = rpc.request(resolve.owner, { label: 'doom' });

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
    const fake = createFakeFrame(silentFrame(served), { timers });
    const rpc = createFrameRpc(fake.frame, timers);
    const write = failure(rpc.request(storage.modeWrite, { siteId: 'dotli', key: 'k', value: 'v' }));

    // When the frame is dropped before the write goes out
    fake.lose(new Error(PROTOCOL_ERRORS.FRAME_RESET));
    await timers.advance(30_000);

    // Then
    expect((await write).message).toBe(PROTOCOL_ERRORS.FRAME_RESET);
    expect(served).toEqual([]);
    expect(metrics.counted(S.PROTOCOL_REQUEST)).not.toContainEqual(expect.objectContaining({ outcome: 'timeout' }));
  });

  it('As a dotli integrator, a request the frame never answers times out on its budget and is counted', async () => {
    // Given
    const fake = createFakeFrame(silentFrame([]), { timers });
    const rpc = createFrameRpc(fake.frame, timers);
    const read = failure(rpc.request(storage.authRead, { siteId: 'dotli', key: 'k' }));
    await settle();

    // When
    await timers.advance(30_000);

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
    const fake = createFakeFrame(silentFrame([]), { status: 'booting', timers });
    const rpc = createFrameRpc(fake.frame, timers);
    let settled = false;
    const owner = failure(rpc.request(resolve.owner, { label: 'doom' })).finally(() => {
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

  it('As the host booting, my wallet read fails on its budget while the frame never loads, and is never served', async () => {
    // Given a frame that stays booting
    const served: string[] = [];
    const fake = createFakeFrame(silentFrame(served), { status: 'booting', timers });
    const rpc = createFrameRpc(fake.frame, timers);
    const read = failure(rpc.request(wallet.read, { siteId: 'dotli' }));

    // When
    await timers.advance(5_000);

    // Then
    expect((await read).name).toBe('ProtocolTimeoutError');
    expect(served).toEqual([]);
    expect(metrics.counted(S.PROTOCOL_REQUEST)).toContainEqual({
      outcome: 'timeout',
      method: 'localWalletRead',
      reason: 'ProtocolTimeoutError',
    });
  });

  it('As the host booting, my shared store call is timed from when it goes out after the handshake, not from the boot', async () => {
    // Given a wallet read made while the frame boots, on a frame that answers at once
    const fake = createFakeFrame(
      serving => {
        serving.handleRequest(wallet.read, () => ok({ tag: 'none' as const, value: undefined }));
      },
      { status: 'booting', timers },
    );
    const rpc = createFrameRpc(fake.frame, timers, () => timers.now());
    const read = rpc.request(wallet.read, { siteId: 'dotli' });

    // When the frame listens 3 s later
    await timers.advance(3_000);
    fake.setStatus('listening');
    await settle();

    // Then
    await expect(read).resolves.toEqual({ tag: 'none', value: undefined });
    expect(
      metrics.distributions.filter(metric => metric.name === `dotli.${S.PROTOCOL_REQUEST}`).map(metric => metric.value),
    ).toEqual([0]);
  });

  it('As a dotli integrator, a request is timed on the clock I give it, apart from the timers its budget runs on', async () => {
    // Given a frame that answers once the test says, and a clock apart from the timers
    const answer = deferred<string | null>();
    const fake = createFakeFrame(
      serving => {
        serving.handleRequest(resolve.owner, () => answer.promise.then(value => ok(value)));
      },
      { timers },
    );
    let clock = 0;
    const rpc = createFrameRpc(fake.frame, timers, () => clock);
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
      metrics.distributions.filter(metric => metric.name === `dotli.${S.PROTOCOL_REQUEST}`).map(metric => metric.value),
    ).toEqual([40]);
  });

  it('As the host booting, my shared store calls queued on a frame whose boot fails fail with why and count nothing', async () => {
    // Given two shared store calls made while the frame boots
    const fake = createFakeFrame(silentFrame([]), { status: 'booting', timers });
    const rpc = createFrameRpc(fake.frame, timers);
    const read = failure(rpc.request(storage.authRead, { siteId: 'dotli', key: 'k' }));
    const write = failure(rpc.request(storage.modeWrite, { siteId: 'dotli', key: 'k', value: 'v' }));
    await settle();

    // When the boot fails
    fake.lose(new Error('boot failed'));
    await settle();

    // Then the frame counts its own boot failure, so the calls add nothing
    expect((await read).message).toBe('boot failed');
    expect((await write).message).toBe('boot failed');
    expect(metrics.counted(S.PROTOCOL_REQUEST)).toEqual([]);
    expect(metrics.distributions.filter(metric => metric.name === `dotli.${S.PROTOCOL_REQUEST}`)).toEqual([]);
  });

  it('As the host booting, my wallet read keeps only what the wait for the frame left of its budget', async () => {
    // Given a wallet read made while the frame boots, which listens 3 s later
    const served: string[] = [];
    const fake = createFakeFrame(silentFrame(served), { status: 'booting', timers });
    const rpc = createFrameRpc(fake.frame, timers);
    let settled = false;
    const read = failure(rpc.request(wallet.read, { siteId: 'dotli' })).finally(() => {
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
