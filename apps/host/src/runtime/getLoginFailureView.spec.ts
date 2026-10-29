// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getLoginFailureView } from './getLoginFailureView.js';

describe('login failure view', () => {
  it('As a user whose phone has no allowance slot left, I fail to log in and the failure says so with no retry', () => {
    // Given a failure for no free allowance slots
    const kind = 'NoFreeAllowanceSlots';

    // When it is shown
    const view = getLoginFailureView(kind, 'no free slots');

    // Then the view names the missing slots and offers no retry
    expect(view).toMatchObject({ kind: 'error', title: 'No Statement Store slots left', retry: false });
  });
});
