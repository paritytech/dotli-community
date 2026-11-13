// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { arrangeErrorActions, type ErrorAction } from './arrangeErrorActions.js';

describe('error page actions', () => {
  it('As a visitor, I see two buttons with none marked and the first is recommended', () => {
    // When
    const buttons = arrangeLabelled([
      { label: 'A', onClick: ignoreClick },
      { label: 'B', onClick: ignoreClick },
    ]);

    // Then
    expect(buttons.find(b => b.id === 'error-retry-btn')?.primary).toBe(true);
    expect(buttons.find(b => b.id === 'error-retry-btn-1')?.primary).toBe(false);
  });

  // The gated failover screen puts `Go Back` second and primary, and its two-step confirmation depends on that.
  it('As a visitor, I see a button marked primary and it is the recommended one wherever it sits', () => {
    // When
    const buttons = arrangeLabelled([
      { label: 'A', onClick: ignoreClick },
      { label: 'B', primary: true, onClick: ignoreClick },
    ]);

    // Then
    expect(buttons.find(b => b.id === 'error-retry-btn')?.primary).toBe(false);
    expect(buttons.find(b => b.id === 'error-retry-btn-1')?.primary).toBe(true);
  });

  // The primary is first in the array but rendered last, the only arrangement that catches an id keyed on render
  // position. Reading, DOM and tab order must agree, so the primary is never placed with CSS `order`.
  it('As a test author, I find the first action by its id and it keeps that id even when it renders last', () => {
    // When
    const buttons = arrangeLabelled([
      { label: 'Reload', primary: true, onClick: ignoreClick },
      { label: 'Open Settings', onClick: ignoreClick },
    ]);

    // Then
    expect(buttons).toEqual([
      { label: 'Open Settings', id: 'error-retry-btn-1', primary: false },
      { label: 'Reload', id: 'error-retry-btn', primary: true },
    ]);
  });
});

function ignoreClick(): void {}

function arrangeLabelled(actions: ErrorAction[]): { label: string; id: string; primary: boolean }[] {
  return arrangeErrorActions(actions).map(({ action, id, primary }) => ({ label: action.label, id, primary }));
}
