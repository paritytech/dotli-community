// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEchoHold } from './echo-hold.js';

/** A text field the user types in, which counts the product's writes since each moves the caret. */
function setup() {
  const field = { text: '', focused: false, writes: 0 };
  const hold = createEchoHold({
    value: () => field.text,
    write: text => {
      field.text = text;
      field.writes += 1;
    },
    isFocused: () => field.focused,
  });
  hold.reset('');
  /** Keystrokes 100 ms apart, each leaving `value` in the field. */
  const type = (...values: string[]): void => {
    for (const value of values) {
      field.text = value;
      hold.typed();
      vi.advanceTimersByTime(100);
    }
  };
  return { field, hold, type };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a text field the product echoes', () => {
  it('As a user typing, a late echo of an earlier keystroke does not replace my text', () => {
    // Given
    const { field, hold, type } = setup();
    field.focused = true;
    type('a', 'ab', 'abc');

    // When: the echo of "a" arrives.
    hold.receive('a');

    // Then
    expect(field.text).toBe('abc');

    // When: I keep typing, and the later echoes arrive in between.
    hold.receive('ab');
    type('abcd');
    hold.receive('abc');

    // Then
    expect(field.text).toBe('abcd');
  });

  it("As a user who stopped typing, the product's latest text applies only when it differs from mine", () => {
    // Given: echoes of my own text, held while I typed.
    const { field, hold, type } = setup();
    field.focused = true;
    type('a', 'ab', 'abc');
    hold.receive('a');
    hold.receive('abc');

    // When: typing pauses.
    vi.advanceTimersByTime(1000);

    // Then: my text stays and is not rewritten, so my caret stays, since the product agrees.
    expect(field.text).toBe('abc');
    expect(field.writes).toBe(0);

    // When: the product rewrites the text while I type.
    type('abcd');
    hold.receive('ABCD');

    // Then: held while I type.
    expect(field.text).toBe('abcd');

    // When: I pause.
    vi.advanceTimersByTime(1000);

    // Then
    expect(field.text).toBe('ABCD');
  });

  it("As a user who left the field, the product's text applies at once", () => {
    // Given: I typed, then moved focus away.
    const { field, hold, type } = setup();
    field.focused = true;
    type('a', 'ab');
    field.focused = false;

    // When
    hold.receive('Bob');

    // Then
    expect(field.text).toBe('Bob');
  });

  it('As a user, a field handed to another one drops what was held for the old one', () => {
    // Given: an echo held while I typed.
    const { field, hold, type } = setup();
    field.focused = true;
    type('a');
    hold.receive('A');

    // When: the element now shows another field, with its own text.
    hold.reset('');
    field.text = '';
    vi.advanceTimersByTime(1000);

    // Then
    expect(field.text).toBe('');
  });
});
