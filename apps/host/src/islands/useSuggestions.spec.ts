// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createRoot, createSignal, flush } from 'solid-js';
import { createNavComboboxState, type NavKey } from '../state/navComboboxState.js';
import { getSuggestionId, SUGGESTIONS_ID } from '../components/landing/suggestionIds.js';
import { useSuggestions } from './useSuggestions.js';

const LABELS = ['ant', 'apple', 'avocado', 'banana'];

/** The suggestions under a fresh owner, over a focused input holding `initial`, settled. */
function mount(initial: string) {
  const [text, setText] = createSignal(initial, { ownedWrite: true });
  const [focused, setFocused] = createSignal(true, { ownedWrite: true });
  const combobox = createNavComboboxState();
  const open = vi.fn();
  const { suggestions, dispose } = createRoot(d => ({
    suggestions: useSuggestions({ text, focused, labels: () => LABELS, suffix: () => '.dot', combobox, open }),
    dispose: d,
  }));
  onTestFinished(dispose);
  flush();
  return {
    suggestions,
    open,
    listbox: () => combobox.listbox.get(),
    type(next: string): void {
      setText(next);
      flush();
    },
    blur(): void {
      setFocused(false);
      flush();
    },
    press(key: NavKey): boolean {
      const taken = combobox.press(key);
      flush();
      return taken;
    },
  };
}

describe('useSuggestions', () => {
  it('As a visitor typing in the focused input, I type the start of a name and see the matching app labels', () => {
    // Given the focused input, empty
    const view = mount('');

    // When
    view.type('a');

    // Then
    expect(view.suggestions.shown()).toEqual(['ant', 'apple', 'avocado']);
  });

  it('As a visitor, I leave the input and the suggestions hide', () => {
    // Given the suggestions for "a"
    const view = mount('a');

    // When
    view.blur();

    // Then
    expect(view.suggestions.shown()).toEqual([]);
    expect(view.listbox()).toBeNull();
  });

  it('As a visitor, I press ArrowDown twice and ArrowUp once and the first label is active, with the input pointing at its option', () => {
    // Given the suggestions for "a"
    const view = mount('a');

    // When
    view.press('ArrowDown');
    view.press('ArrowDown');
    view.press('ArrowUp');

    // Then
    expect(view.suggestions.active()).toBe('ant');
    expect(view.listbox()).toEqual({ id: SUGGESTIONS_ID, activeId: getSuggestionId('ant') });
  });

  it('As a visitor, I press ArrowUp on the first label and the active option wraps to the last', () => {
    // Given the first label active
    const view = mount('a');
    view.press('ArrowDown');

    // When
    view.press('ArrowUp');

    // Then
    expect(view.suggestions.active()).toBe('avocado');
  });

  it('As a visitor, I press ArrowDown on the last label and the active option wraps to the first', () => {
    // Given the last label active
    const view = mount('a');
    view.press('ArrowUp');

    // When
    view.press('ArrowDown');

    // Then
    expect(view.suggestions.active()).toBe('ant');
  });

  it('As a visitor, I press Enter on an active label and that name opens', () => {
    // Given the second label active
    const view = mount('a');
    view.press('ArrowDown');
    view.press('ArrowDown');

    // When
    const taken = view.press('Enter');

    // Then
    expect(taken).toBe(true);
    expect(view.open).toHaveBeenCalledWith('apple');
  });

  it('As a visitor, I press Enter with no active label and the key is left to the form', () => {
    // Given the suggestions for "a", none active
    const view = mount('a');

    // When
    const taken = view.press('Enter');

    // Then
    expect(taken).toBe(false);
    expect(view.open).not.toHaveBeenCalled();
  });

  it.each<NavKey>(['ArrowDown', 'ArrowUp', 'Escape'])(
    'As a visitor with no list shown, I press %s and the form keeps it',
    key => {
      // Given text that matches nothing
      const view = mount('zebra');

      // When
      const taken = view.press(key);

      // Then
      expect(taken).toBe(false);
    },
  );

  it('As a visitor, I press Escape and the list hides', () => {
    // Given the suggestions for "a"
    const view = mount('a');

    // When
    view.press('Escape');

    // Then
    expect(view.suggestions.shown()).toEqual([]);
    expect(view.listbox()).toBeNull();
  });

  it('As a visitor, I press Escape and type a character and the list shows again', () => {
    // Given the list hidden by Escape at "a"
    const view = mount('a');
    view.press('Escape');

    // When
    view.type('ap');

    // Then
    expect(view.suggestions.shown()).toEqual(['apple']);
  });

  it('As a visitor, I press Escape, type a character and delete it, and the list stays shown', () => {
    // Given the list hidden by Escape at "a", then shown at "ap"
    const view = mount('a');
    view.press('Escape');
    view.type('ap');

    // When
    view.type('a');

    // Then
    expect(view.suggestions.shown()).toEqual(['ant', 'apple', 'avocado']);
  });

  it('As a visitor, I type past the active label and back and no label is active', () => {
    // Given "apple" active at "ap"
    const view = mount('ap');
    view.press('ArrowDown');

    // When the text moves past it and returns
    view.type('apx');
    view.type('ap');

    // Then
    expect(view.suggestions.active()).toBeNull();
  });

  it('As a visitor, I type past the active label and it is dropped', () => {
    // Given "ant" active
    const view = mount('a');
    view.press('ArrowDown');

    // When
    view.type('ap');

    // Then
    expect(view.suggestions.active()).toBeNull();
    expect(view.listbox()).toEqual({ id: SUGGESTIONS_ID, activeId: null });
  });
});
