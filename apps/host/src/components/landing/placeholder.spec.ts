// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { animatePlaceholder } from './placeholder.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('animatePlaceholder', () => {
  it('As a visitor, the placeholder types example names in turn, pauses while I type, and stops when the page goes', () => {
    // Given
    const input = { placeholder: '', value: '' };
    const placeholder = animatePlaceholder(input, false);
    expect(input.placeholder).toBe('browse');

    // When: the hold ends, then one character is erased.
    vi.advanceTimersByTime(1400);
    vi.advanceTimersByTime(45);

    // Then
    expect(input.placeholder).toBe('brows');

    // When: the rest is erased and the next name typed.
    vi.advanceTimersByTime(45 * 5 + 95 * 6);

    // Then
    expect(input.placeholder).toBe('mark3t');

    // When: the visitor types, the cycle pauses.
    input.value = 'x';
    placeholder.resume();
    vi.advanceTimersByTime(10_000);

    // Then
    expect(input.placeholder).toBe('mark3t');
    expect(vi.getTimerCount()).toBe(0);

    // When: clearing the input resumes it.
    input.value = '';
    placeholder.resume();
    vi.advanceTimersByTime(95);

    // Then
    expect(vi.getTimerCount()).toBe(1);

    // When
    placeholder.stop();

    // Then
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As a visitor who prefers reduced motion, the placeholder shows one name and stays still', () => {
    // Given
    const input = { placeholder: '', value: '' };

    // When
    animatePlaceholder(input, true);

    // Then
    expect(input.placeholder).toBe('browse');
    expect(vi.getTimerCount()).toBe(0);
  });
});
