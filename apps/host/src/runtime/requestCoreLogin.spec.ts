// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { bindReports } from '../testing/bindReports.js';
import { buildLoginResponseFrame } from '../testing/buildLoginResponseFrame.js';
import { getFrameRequestId } from '../testing/getFrameRequestId.js';
import { createFakeProvider } from './createPageCore.fake.js';
import { requestCoreLogin } from './requestCoreLogin.js';

describe('requestCoreLogin', () => {
  it('As a dotli integrator, I request a login the core answers with success and get its answer with nothing left listening', async () => {
    // Given a core that answers the login with success
    bindReports();
    const provider = createFakeProvider({
      onPostMessage(message) {
        provider.listener?.(buildLoginResponseFrame(getFrameRequestId(message), { kind: 'success', value: 'Success' }));
      },
    });

    // When the login is requested
    const login = requestCoreLogin(provider);

    // Then it resolves with the answer and unsubscribes
    await expect(login).resolves.toBe('Success');
    expect(provider.subscribe).toHaveBeenCalledTimes(1);
    expect(provider.listener).toBeNull();
  });

  it('As a dotli integrator, I request a login the core refuses with a typed error and get a LoginRequestError', async () => {
    // Given a core that refuses the login with a domain error
    bindReports();
    const provider = createFakeProvider({
      onPostMessage(message) {
        provider.listener?.(
          buildLoginResponseFrame(getFrameRequestId(message), { kind: 'domain', reason: 'Rejected' }),
        );
      },
    });

    // When the login is requested
    const promise = requestCoreLogin(provider);

    // Then it rejects with the typed error and unsubscribes
    await expect(promise).rejects.toThrow('Rejected');
    await expect(promise).rejects.toMatchObject({
      name: 'LoginRequestError',
      error: {
        tag: 'Domain',
        value: {
          tag: 'V1',
          value: { tag: 'Unknown', value: { reason: 'Rejected' } },
        },
      },
    });
    expect(provider.listener).toBeNull();
  });

  it('As a dotli integrator, I request a login that fails on the host and get its reason as the error message', async () => {
    // Given a core whose host fails the login
    bindReports();
    const reason = 'no free statement-store slot for device registration';
    const provider = createFakeProvider({
      onPostMessage(message) {
        provider.listener?.(buildLoginResponseFrame(getFrameRequestId(message), { kind: 'hostFailure', reason }));
      },
    });

    // When the login is requested
    const promise = requestCoreLogin(provider);

    // Then it rejects with the reason and unsubscribes
    await expect(promise).rejects.toThrow(reason);
    await expect(promise).rejects.toMatchObject({
      name: 'LoginRequestError',
      error: { tag: 'HostFailure', value: { reason } },
    });
    expect(provider.listener).toBeNull();
  });

  it('As an operator, I see frames that do not decode during a login reported once and the login still resolves', async () => {
    // Given a core that sends two frames that do not decode before its answer
    const { captures, counted } = bindReports();
    const provider = createFakeProvider({
      onPostMessage(message) {
        provider.listener?.(new Uint8Array([0xff, 0x00]));
        provider.listener?.(new Uint8Array([0xfe]));
        provider.listener?.(buildLoginResponseFrame(getFrameRequestId(message), { kind: 'success', value: 'Success' }));
      },
    });

    // When the login is requested
    const login = requestCoreLogin(provider);

    // Then it resolves, and the frames are reported and counted once
    await expect(login).resolves.toBe('Success');
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ step: 'login_frame' }));
    expect(counted('wallet.login_frame')).toEqual([{ outcome: 'error', reason: 'undecodable_frame' }]);
  });

  it('As a dotli integrator, I request a login whose send fails and it rejects with nothing left listening', async () => {
    // Given a core that cannot be sent to
    bindReports();
    const provider = createFakeProvider({
      onPostMessage() {
        throw new Error('send failed');
      },
    });

    // When the login is requested
    const login = requestCoreLogin(provider);

    // Then it rejects with the send failure and unsubscribes
    await expect(login).rejects.toThrow('send failed');
    expect(provider.listener).toBeNull();
  });

  it('As a dotli integrator, I request a login whose core provider closes and it rejects with nothing left listening', async () => {
    // Given a login waiting for its answer
    bindReports();
    const provider = createFakeProvider();
    const promise = requestCoreLogin(provider);

    // When the core provider closes
    provider.closeListener?.(new Error('core transport closed'));

    // Then it rejects with the close and unsubscribes both listeners
    await expect(promise).rejects.toThrow('core transport closed');
    expect(provider.listener).toBeNull();
    expect(provider.closeListener).toBeNull();
  });
});
