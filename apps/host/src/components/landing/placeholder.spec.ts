// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  animatePlaceholder,
  PLACEHOLDER_ERASE_MS as ERASE_MS,
  PLACEHOLDER_HOLD_MS as HOLD_MS,
  PLACEHOLDER_TYPE_MS as TYPE_MS,
} from './placeholder.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advances past the hold and the full erase of "browse" and the typing of "mark3t". */
const showSecondName = (): void => {
  vi.advanceTimersByTime(HOLD_MS + ERASE_MS * 6 + TYPE_MS * 6);
};

describe('animatePlaceholder', () => {
  it('As a visitor, the placeholder starts on the first example name', () => {
    // Given
    const input = { placeholder: '', value: '' };

    // When
    animatePlaceholder(input, false);

    // Then
    expect(input.placeholder).toBe('browse');
  });

  it('As a visitor, the placeholder holds the first name, then erases it one character at a time', () => {
    // Given
    const input = { placeholder: '', value: '' };
    animatePlaceholder(input, false);

    // When
    vi.advanceTimersByTime(HOLD_MS + ERASE_MS - 1);

    // Then
    expect(input.placeholder).toBe('browse');

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(input.placeholder).toBe('brows');
  });

  it('As a visitor, the placeholder types the next example name after erasing the first', () => {
    // Given
    const input = { placeholder: '', value: '' };
    animatePlaceholder(input, false);

    // When
    showSecondName();

    // Then
    expect(input.placeholder).toBe('mark3t');
  });

  it('As a visitor typing in the input, the placeholder stops changing', () => {
    // Given
    const input = { placeholder: '', value: '' };
    const placeholder = animatePlaceholder(input, false);
    showSecondName();

    // When
    input.value = 'x';
    placeholder.resume();
    vi.advanceTimersByTime(10_000);

    // Then
    expect(input.placeholder).toBe('mark3t');
  });

  it('As a visitor who clears the input, the placeholder carries on from where it paused', () => {
    // Given
    const input = { placeholder: '', value: '' };
    const placeholder = animatePlaceholder(input, false);
    showSecondName();
    input.value = 'x';
    placeholder.resume();
    vi.advanceTimersByTime(10_000);

    // When
    input.value = '';
    placeholder.resume();
    vi.advanceTimersByTime(TYPE_MS + ERASE_MS - 1);

    // Then
    expect(input.placeholder).toBe('mark3t');

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(input.placeholder).toBe('mark3');
  });

  it('As a visitor leaving the page, the placeholder stops changing for good', () => {
    // Given
    const input = { placeholder: '', value: '' };
    const placeholder = animatePlaceholder(input, false);
    vi.advanceTimersByTime(HOLD_MS + ERASE_MS);
    expect(input.placeholder).toBe('brows');

    // When
    placeholder.stop();
    vi.advanceTimersByTime(10_000);

    // Then
    expect(input.placeholder).toBe('brows');
  });

  it('As a visitor who prefers reduced motion, the placeholder shows one name and stays still', () => {
    // Given
    const input = { placeholder: '', value: '' };

    // When
    animatePlaceholder(input, true);
    vi.advanceTimersByTime(10_000);

    // Then
    expect(input.placeholder).toBe('browse');
  });
});
