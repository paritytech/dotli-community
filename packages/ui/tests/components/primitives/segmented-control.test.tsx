// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from '../../../src/components/primitives/SegmentedControl.js';
import { mouseClick, renderComponent } from '../../helpers/solid.js';
import { byTestId } from '../../support.js';

type Status = 'ask' | 'allow' | 'deny';
const OPTIONS = [
  { value: 'ask', label: 'Ask', testId: 'seg-ask' },
  { value: 'allow', label: 'Allow', testId: 'seg-allow' },
  { value: 'deny', label: 'Deny', testId: 'seg-deny' },
] as const;

describe('SegmentedControl', () => {
  it('As an assistive technology user, I hear a named group with the current option pressed', () => {
    // Given / When
    renderComponent(() => (
      <SegmentedControl<Status> label="Camera" options={OPTIONS} value="allow" onChange={() => {}} testId="seg" />
    ));

    // Then
    const group = byTestId('seg');
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Camera');
    expect(byTestId('seg-ask').getAttribute('aria-pressed')).toBe('false');
    expect(byTestId('seg-allow').getAttribute('aria-pressed')).toBe('true');
    expect(byTestId('seg-deny').getAttribute('aria-pressed')).toBe('false');
  });

  it('As a user, I pick another option and the control reports it', () => {
    // Given
    const onChange = vi.fn();
    renderComponent(() => (
      <SegmentedControl<Status> label="Camera" options={OPTIONS} value="ask" onChange={onChange} />
    ));

    // When
    mouseClick(byTestId('seg-deny'));

    // Then
    expect(onChange).toHaveBeenCalledExactlyOnceWith('deny');
  });

  it('As a user, I press the option that is already picked and nothing changes', () => {
    // Given
    const onChange = vi.fn();
    renderComponent(() => (
      <SegmentedControl<Status> label="Camera" options={OPTIONS} value="ask" onChange={onChange} />
    ));

    // When
    mouseClick(byTestId('seg-ask'));

    // Then
    expect(onChange).not.toHaveBeenCalled();
  });
});
