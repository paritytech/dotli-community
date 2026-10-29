// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isActionNeeded } from './isActionNeeded.js';

const CALM = { visible: false, blockingModalActive: false, blockingModalsWaiting: 0 };

describe('The action flag on the status capsule', () => {
  it.each([
    { situation: 'with nothing pending', sees: 'no action dot', state: CALM, chatUnread: 0, expected: false },
    { situation: 'with unread chat', sees: 'the action dot', state: CALM, chatUnread: 3, expected: true },
    {
      situation: 'with a prompt waiting behind another',
      sees: 'the action dot',
      state: { ...CALM, blockingModalActive: true, blockingModalsWaiting: 1, visible: true },
      chatUnread: 0,
      expected: true,
    },
    {
      situation: 'with a prompt open while the bar is collapsed',
      sees: 'the action dot',
      state: { ...CALM, blockingModalActive: true },
      chatUnread: 0,
      expected: true,
    },
    {
      situation: 'with a prompt open while the bar is open',
      sees: 'no action dot',
      state: { ...CALM, blockingModalActive: true, visible: true },
      chatUnread: 0,
      expected: false,
    },
  ])('As a user $situation, I look at the status capsule and see $sees', ({ state, chatUnread, expected }) => {
    // When
    const needed = isActionNeeded(state, chatUnread);

    // Then
    expect(needed).toBe(expected);
  });
});
