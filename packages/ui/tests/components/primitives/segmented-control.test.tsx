// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createSignal, flush } from 'solid-js';
import { SegmentedControl } from '../../../src/components/primitives/SegmentedControl.js';
import { mouseClick, renderComponent } from '../../helpers/solid.js';
import { byTestId } from '../../support.js';

type Status = 'ask' | 'allow' | 'deny';
const TEST_IDS = ['seg-ask', 'seg-allow', 'seg-deny'];
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

  it('As a keyboard user, the control is one Tab stop, on the pressed option, and it follows the value', () => {
    // Given
    const [value, setValue] = createSignal<Status>('allow');
    renderComponent(() => (
      <SegmentedControl<Status> label="Camera" options={OPTIONS} value={value()} onChange={setValue} />
    ));

    // Then
    expect(tabIndexes()).toEqual(['-1', '0', '-1']);

    // When
    mouseClick(byTestId('seg-deny'));
    flush();

    // Then
    expect(tabIndexes()).toEqual(['-1', '-1', '0']);
  });

  it('As a keyboard user, with no option pressed, the first option is the Tab stop', () => {
    // Given / When
    renderComponent(() => (
      <SegmentedControl<Status | 'unset'> label="Camera" options={OPTIONS} value="unset" onChange={() => {}} />
    ));

    // Then
    expect(tabIndexes()).toEqual(['0', '-1', '-1']);
  });

  it('As a keyboard user, the arrow keys move focus between the options, wrapping, and Home and End go to the ends, without picking', () => {
    // Given
    const onChange = vi.fn();
    renderComponent(() => (
      <SegmentedControl<Status> label="Camera" options={OPTIONS} value="allow" onChange={onChange} />
    ));
    byTestId('seg-allow').focus();

    // When / Then
    const steps: [string, string][] = [
      ['ArrowRight', 'seg-deny'],
      ['ArrowRight', 'seg-ask'],
      ['ArrowLeft', 'seg-deny'],
      ['ArrowDown', 'seg-ask'],
      ['ArrowUp', 'seg-deny'],
      ['Home', 'seg-ask'],
      ['End', 'seg-deny'],
    ];
    for (const [key, focused] of steps) {
      expect(press(key).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(byTestId(focused));
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(byTestId('seg-allow').getAttribute('aria-pressed')).toBe('true');
    expect(tabIndexes()).toEqual(['-1', '0', '-1']);
  });

  it('As a keyboard user, other keys pass through the control untouched', () => {
    // Given
    renderComponent(() => (
      <SegmentedControl<Status> label="Camera" options={OPTIONS} value="allow" onChange={() => {}} />
    ));
    byTestId('seg-allow').focus();

    // When
    const tab = press('Tab');

    // Then
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byTestId('seg-allow'));
  });
});

/** Each option's tabindex, in order. */
function tabIndexes(): (string | null)[] {
  return TEST_IDS.map(id => byTestId(id).getAttribute('tabindex'));
}

/** A keydown on the focused element. */
function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}
