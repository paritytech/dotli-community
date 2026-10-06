// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { Switch } from '../../../src/components/primitives/Switch.js';
import { mouseClick, renderComponent } from '../../helpers/solid.js';
import { byTestId } from '../../support.js';

describe('Switch', () => {
  it('As an assistive technology user, I hear a named switch and whether it is on', () => {
    // Given / When
    renderComponent(() => <Switch label="Archive cache" checked={true} onChange={() => {}} testId="sw" />);

    // Then
    const sw = byTestId('sw', document, HTMLButtonElement);
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.getAttribute('aria-label')).toBe('Archive cache');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.type).toBe('button');
  });

  it('As a user, I flip the switch and its owner hears the next value without the switch flipping itself', () => {
    // Given
    const onChange = vi.fn();
    renderComponent(() => <Switch label="Worker cache" checked={false} onChange={onChange} testId="sw" />);

    // When
    mouseClick(byTestId('sw'));

    // Then
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(byTestId('sw').getAttribute('aria-checked')).toBe('false');
  });
});
