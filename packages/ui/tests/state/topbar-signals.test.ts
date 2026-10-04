// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { needsAction } from '../../src/state/topbar-signals.js';

const calm = { visible: false, blockingModalActive: false, blockingModalsWaiting: 0 };

describe('The action flag on the status capsule', () => {
  it('As a user with nothing pending, I see no action dot', () => {
    expect(needsAction(calm, 0)).toBe(false);
  });

  it('As a user with unread chat, I see the action dot', () => {
    expect(needsAction(calm, 3)).toBe(true);
  });

  it('As a user with a prompt waiting behind another, I see the action dot', () => {
    expect(needsAction({ ...calm, blockingModalActive: true, blockingModalsWaiting: 1, visible: true }, 0)).toBe(true);
  });

  it('As a user with a prompt open while the bar is collapsed, I see the action dot, and not once the bar is open', () => {
    expect(needsAction({ ...calm, blockingModalActive: true }, 0)).toBe(true);
    expect(needsAction({ ...calm, blockingModalActive: true, visible: true }, 0)).toBe(false);
  });
});
