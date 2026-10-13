// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { arrangeErrorActions, type ErrorAction } from './error-page.js';

const noop = (): void => undefined;

function arranged(actions: ErrorAction[]): { label: string; id: string; primary: boolean }[] {
  return arrangeErrorActions(actions).map(({ action, id, primary }) => ({ label: action.label, id, primary }));
}

describe('error page actions', () => {
  it('As a visitor, a lone button is the recommended one', () => {
    // When
    const buttons = arranged([{ label: 'A', onClick: noop }]);

    // Then
    expect(buttons).toEqual([{ label: 'A', id: 'error-retry-btn', primary: true }]);
  });

  it('As a visitor, the first button is recommended when none is marked', () => {
    // When
    const buttons = arranged([
      { label: 'A', onClick: noop },
      { label: 'B', onClick: noop },
    ]);

    // Then
    expect(buttons.find(b => b.id === 'error-retry-btn')?.primary).toBe(true);
    expect(buttons.find(b => b.id === 'error-retry-btn-1')?.primary).toBe(false);
  });

  // The gated failover screen puts `Go Back` second and primary, and its two-step confirmation depends on that.
  it('As a visitor, the button marked primary is the recommended one wherever it sits', () => {
    // When
    const buttons = arranged([
      { label: 'A', onClick: noop },
      { label: 'B', primary: true, onClick: noop },
    ]);

    // Then
    expect(buttons.find(b => b.id === 'error-retry-btn')?.primary).toBe(false);
    expect(buttons.find(b => b.id === 'error-retry-btn-1')?.primary).toBe(true);
  });

  // Reading, DOM and tab order must agree, so the primary is never placed with CSS `order`.
  it('As a keyboard user, I reach the buttons in the order I read them', () => {
    // When
    const buttons = arranged([
      { label: 'Reload', primary: true, onClick: noop },
      { label: 'Open Settings', onClick: noop },
    ]);

    // Then
    expect(buttons.map(b => b.label)).toEqual(['Open Settings', 'Reload']);
  });

  it('As a visitor, a lone button keeps its place', () => {
    // When
    const buttons = arranged([{ label: 'Only', primary: true, onClick: noop }]);

    // Then
    expect(buttons.map(b => b.label)).toEqual(['Only']);
  });

  // The primary is first in the array but rendered last, the only arrangement that catches an id keyed on render
  // position.
  it('As a test author, the first action keeps its id even when it renders last', () => {
    // When
    const buttons = arranged([
      { label: 'Reload', primary: true, onClick: noop },
      { label: 'Open Settings', onClick: noop },
    ]);

    // Then
    expect(buttons).toEqual([
      { label: 'Open Settings', id: 'error-retry-btn-1', primary: false },
      { label: 'Reload', id: 'error-retry-btn', primary: true },
    ]);
  });

  it('As a test author, the first action keeps its id whichever button is primary', () => {
    // When
    const buttons = arranged([
      { label: 'First', onClick: noop },
      { label: 'Second', primary: true, onClick: noop },
    ]);

    // Then
    expect(buttons.find(b => b.label === 'First')?.id).toBe('error-retry-btn');
  });
});
