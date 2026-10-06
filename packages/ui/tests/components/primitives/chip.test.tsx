// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { Chip } from '../../../src/components/primitives/Chip.js';
import { StatusDot } from '../../../src/components/primitives/StatusDot.js';
import { renderComponent } from '../../helpers/solid.js';
import { byTestId } from '../../support.js';

describe('Chip and StatusDot', () => {
  it('As a user, I read the chip text', () => {
    // Given / When
    renderComponent(() => (
      <Chip tone="ok" testId="chip">
        Recommended
      </Chip>
    ));

    // Then
    expect(byTestId('chip').textContent).toBe('Recommended');
  });

  it('As an assistive technology user, I do not hear a status dot, which only repeats nearby text', () => {
    // Given / When
    renderComponent(() => <StatusDot tone="warn" testId="dot" />);

    // Then
    expect(byTestId('dot').getAttribute('aria-hidden')).toBe('true');
  });
});
