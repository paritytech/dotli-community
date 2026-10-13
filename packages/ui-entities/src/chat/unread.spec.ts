// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { chatUnreadLabel } from './unread.js';

describe('chatUnreadLabel', () => {
  it('As a user, unread counts above nine read 9+', () => {
    // When / Then
    expect(chatUnreadLabel(3)).toBe('3');
    expect(chatUnreadLabel(10)).toBe('9+');
  });
});
