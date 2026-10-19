// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { toError } from '@dotli/shared';
import { manualTimers, type ManualTimers } from '@dotli/shared/testing';
import { domain, err, hostFailure, ok } from '@dotli/transport';
import { PROTOCOL_ERRORS } from './errors.js';
import { createRemoteResolve } from './remote-resolve.js';
import { createFrameRpc } from './rpc.js';
import { createFakeFrame } from './frame.fake.js';
import { protocolSchema, type ProtocolHandler, type ProtocolTransport } from './schema.js';

const { dotName } = protocolSchema.sections.resolve;

/** A frame app that resolves names with `handler`. */
function resolving(handler: ProtocolHandler<typeof dotName>): (serving: ProtocolTransport) => void {
  return serving => {
    serving.handleSubscription(dotName, handler);
  };
}

/** How a resolution failed, read once it has. */
function failure<T>(resolution: Promise<T>): Promise<Error> {
  return resolution.then(() => new Error('the resolution succeeded'), toError);
}

describe('createRemoteResolve', () => {
  let timers: ManualTimers;

  function resolveOver(serve: (serving: ProtocolTransport) => void) {
    const fake = createFakeFrame(serve, { timers });
    return createRemoteResolve(createFrameRpc(fake.frame, timers));
  }

  beforeEach(() => {
    timers = manualTimers();
  });

  it('As the host, I hear each phase, then the resolved name', async () => {
    // Given
    const asked: string[] = [];
    const resolve = resolveOver(
      resolving(({ label }, _context, sink) => {
        asked.push(label);
        sink.send({ tag: 'phase', value: 'asset-hub-syncing' });
        sink.send({ tag: 'phase', value: 'resolving-content' });
        sink.send({ tag: 'resolved', value: '0xcid' });
        sink.interrupt(ok());
        return () => undefined;
      }),
    );
    const phases: string[] = [];

    // When
    const cid = resolve.resolveDotNameRemote('doom', phase => phases.push(phase));
    await timers.advance(0);

    // Then
    await expect(cid).resolves.toBe('0xcid');
    expect(asked).toEqual(['doom']);
    expect(phases).toEqual(['asset-hub-syncing', 'resolving-content']);
  });

  it('As the host, I stop a resolution in the frame once I have its result, even if the frame does not end it', async () => {
    // Given a frame app that sends the result and leaves the subscription open
    let stopped = false;
    const resolve = resolveOver(
      resolving((_payload, _context, sink) => {
        sink.send({ tag: 'resolved', value: '0xcid' });
        return () => {
          stopped = true;
        };
      }),
    );

    // When
    const cid = resolve.resolveDotNameRemote('doom');
    await timers.advance(0);

    // Then
    await expect(cid).resolves.toBe('0xcid');
    expect(stopped).toBe(true);
  });

  it('As the host, a resolution that ends before its result rejects', async () => {
    // Given a frame app that stops after a phase
    const resolve = resolveOver(
      resolving((_payload, _context, sink) => {
        sink.send({ tag: 'phase', value: 'asset-hub-syncing' });
        sink.interrupt(ok());
        return () => undefined;
      }),
    );

    // When
    const cid = failure(resolve.resolveDotNameRemote('doom'));
    await timers.advance(0);

    // Then
    expect((await cid).message).toBe(PROTOCOL_ERRORS.RESOLUTION_ENDED);
  });

  it('As the host, a resolver sync timeout in the frame reaches my error screen as NetworkSyncTimeoutError', async () => {
    // Given a frame app whose resolver runs out of sync time
    const message = 'Sync to Asset Hub Paseo timed out after 45s. Unable to reach peers.';
    const resolve = resolveOver(
      resolving((_payload, _context, sink) => {
        sink.interrupt(err(domain({ tag: 'syncTimeout', value: message })));
        return () => undefined;
      }),
    );

    // When
    const cid = failure(resolve.resolveDotNameRemote('doom'));
    await timers.advance(0);

    // Then the error screen matches on the name and reads the chain from the message
    expect(await cid).toMatchObject({ name: 'NetworkSyncTimeoutError', message, method: 'resolveDotName' });
  });

  it('As the host, a resolution the frame fails keeps the name it crossed with, and a bare Error becomes a protocol response error', async () => {
    // Given a frame app whose resolver throws a named error for one name and a bare one for another
    const resolve = resolveOver(
      resolving(({ label }, _context, sink) => {
        sink.interrupt(err(hostFailure(label === 'named' ? 'DotNsError: no' : 'Error: no')));
        return () => undefined;
      }),
    );

    // When
    const named = failure(resolve.resolveDotNameRemote('named'));
    const bare = failure(resolve.resolveDotNameRemote('bare'));
    await timers.advance(0);

    // Then
    expect(await named).toMatchObject({ name: 'DotNsError', message: 'no' });
    expect(await bare).toMatchObject({ name: 'ProtocolResponseError', message: 'no' });
  });

  it('As the host, a resolution that outlives its budget is stopped in the frame and fails as timed out', async () => {
    // Given a frame app that never answers
    let stopped = false;
    const resolve = resolveOver(
      resolving(() => () => {
        stopped = true;
      }),
    );
    const cid = failure(resolve.resolveDotNameRemote('doom'));
    await timers.advance(0);

    // When
    await timers.advance(89_999);
    const stoppedBeforeBudget = stopped;
    await timers.advance(1);

    // Then
    expect(stoppedBeforeBudget).toBe(false);
    expect((await cid).name).toBe('ProtocolTimeoutError');
    expect(stopped).toBe(true);
  });
});
