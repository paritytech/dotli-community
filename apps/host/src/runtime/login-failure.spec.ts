// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { friendlyAuthError, loginFailureView } from './login-failure.js';

describe('login failure copy', () => {
  it('As a new user, I hit a failure worth retrying and see its raw reason and the retry', () => {
    // Given the reason of a dropped transport
    const reason = 'transport closed before the wallet answered';

    // When it is explained
    const copy = friendlyAuthError(reason);

    // Then the copy names the lost connection, keeps the reason and offers a retry
    expect(copy.title).toBe('Connection to Polkadot App was lost');
    expect(copy.detail).toBe(reason);
    expect(copy.retryable).not.toBe(false);
  });

  it('As a new user, I hit a rejected statement-store transaction and see it explained with the raw reason', () => {
    // Given the reason of a rejected transaction
    const reason = 'submit RPC error: Invalid Transaction';

    // When it is explained
    const copy = friendlyAuthError(reason);

    // Then the copy names the rejection, keeps the reason and offers a retry
    expect(copy.title).toBe('Statement Store transaction rejected');
    expect(copy.detail).toBe(reason);
    expect(copy.retryable).not.toBe(false);
  });

  it('As a new user, I am told when I declined the login on my phone', () => {
    // Given the reason of a denied login
    const reason = 'Login request denied';

    // When it is explained
    const copy = friendlyAuthError(reason);

    // Then the copy says it was declined and offers a retry
    expect(copy.title).toBe('Sign-in was declined');
    expect(copy.retryable).not.toBe(false);
  });

  it('As a new user, I am told when Polkadot App did not answer in time', () => {
    // Given the reason of a timed-out call
    const reason = 'runtime call timed out';

    // When it is explained
    const copy = friendlyAuthError(reason);

    // Then the copy says it timed out and offers a retry
    expect(copy.title).toBe('Sign-in timed out');
    expect(copy.retryable).not.toBe(false);
  });

  it('As a new user, I am not offered a retry when this page cannot log in at all', () => {
    // Given the reason of an unsupported login
    const reason = 'Login is not supported by this host';

    // When it is explained
    const copy = friendlyAuthError(reason);

    // Then the copy says sign-in is not available and offers no retry
    expect(copy.title).toBe('Sign-in is not available here');
    expect(copy.retryable).toBe(false);
  });

  it('As a new user, I hit a login runtime that fails to load and read it as a page problem rather than a phone problem', () => {
    // Given the reason of a worker that failed to start
    const reason = 'worker init failed: undefined';

    // When it is explained
    const copy = friendlyAuthError(reason);

    // Then the copy names the sign-in service and offers a retry
    expect(copy.title).toBe('The sign-in service did not start');
    expect(copy.retryable).not.toBe(false);
  });

  it('As a new user, I hit an unknown failure and still read it as a login problem with the raw reason kept for bug reports', () => {
    // Given a reason no copy knows
    const reason = 'Host failure';

    // When it is explained
    const copy = friendlyAuthError(reason);

    // Then the copy is the generic login failure with the raw reason
    expect(copy).toEqual({
      title: 'Sign-in did not complete',
      subtitle:
        'Something interrupted the connection to Polkadot App. Try again, and make sure the app is installed and up to date.',
      detail: reason,
    });
  });

  it('As a user whose phone has no allowance slot left, I fail to log in and the failure says so with no retry', () => {
    // Given a failure for no free allowance slots
    const kind = 'NoFreeAllowanceSlots';

    // When it is shown
    const view = loginFailureView(kind, 'no free slots');

    // Then the view names the missing slots and offers no retry
    expect(view).toMatchObject({ kind: 'error', title: 'No Statement Store slots left', retry: false });
  });
});
