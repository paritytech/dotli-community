// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { IconButton } from '../../../src/components/primitives/IconButton.js';
import { mouseClick, renderComponent } from '../../helpers/solid.js';
import { byTestId } from '../../support.js';

describe('IconButton', () => {
  it('As a user, I press a small icon button by its name and its action runs once', () => {
    // Given
    const onClick = vi.fn();
    renderComponent(() => (
      <IconButton size="sm" aria-label="Dismiss" onClick={onClick} testId="close">
        <svg />
      </IconButton>
    ));
    const button = byTestId('close', document, HTMLButtonElement);

    // When
    mouseClick(button);

    // Then
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-label')).toBe('Dismiss');
    expect(button.getAttribute('data-size')).toBe('sm');
  });
});
