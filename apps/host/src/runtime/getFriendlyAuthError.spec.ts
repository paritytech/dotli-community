// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getFriendlyAuthError } from './getFriendlyAuthError.js';

describe('login failure copy', () => {
  it.each([
    {
      failure: 'a dropped transport',
      reason: 'transport closed before the wallet answered',
      title: 'Connection to Polkadot App was lost',
      retry: true,
    },
    {
      failure: 'a rejected statement-store transaction',
      reason: 'submit RPC error: Invalid Transaction',
      title: 'Statement Store transaction rejected',
      retry: true,
    },
    {
      failure: 'a login I declined on my phone',
      reason: 'Login request denied',
      title: 'Sign-in was declined',
      retry: true,
    },
    {
      failure: 'a login Polkadot App did not answer in time',
      reason: 'runtime call timed out',
      title: 'Sign-in timed out',
      retry: true,
    },
    {
      failure: 'a page that cannot log in at all',
      reason: 'Login is not supported by this host',
      title: 'Sign-in is not available here',
      retry: false,
    },
    {
      failure: 'a login runtime that fails to load, a page problem rather than a phone problem',
      reason: 'worker init failed: undefined',
      title: 'The sign-in service did not start',
      retry: true,
    },
  ])(
    'As a new user, I hit $failure and read "$title" with the raw reason, a retry offered: $retry',
    ({ reason, title, retry }) => {
      // Given the failure's raw reason, as the login reports it
      const reported = reason;

      // When the reason is explained
      const copy = getFriendlyAuthError(reported);

      // Then the copy names the failure, keeps the reason and offers a retry or not
      expect({ title: copy.title, detail: copy.detail, retry: copy.retryable !== false }).toEqual({
        title,
        detail: reason,
        retry,
      });
    },
  );

  it('As a new user, I hit an unknown failure and still read it as a login problem with the raw reason kept for bug reports', () => {
    // Given a reason no copy knows
    const reason = 'Host failure';

    // When it is explained
    const copy = getFriendlyAuthError(reason);

    // Then the copy is the generic login failure with the raw reason
    expect(copy).toEqual({
      title: 'Sign-in did not complete',
      subtitle:
        'Something interrupted the connection to Polkadot App. Try again, and make sure the app is installed and up to date.',
      detail: reason,
    });
  });
});
