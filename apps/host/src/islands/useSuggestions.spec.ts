// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal, flush } from 'solid-js';
import { createNavComboboxState, type NavKey } from '../state/navComboboxState.js';
import { getSuggestionId, SUGGESTIONS_ID } from '../components/landing/suggestionIds.js';
import { useSuggestions } from './useSuggestions.js';

const LABELS = ['ant', 'apple', 'avocado', 'banana'];

/** The suggestions under a fresh owner, over a focused input holding `text`, settled. */
function mount(text: string) {
  const [input, setInput] = createSignal({ text, focused: true }, { ownedWrite: true });
  const combobox = createNavComboboxState();
  const open = vi.fn();
  const { suggestions, dispose } = createRoot(d => ({
    suggestions: useSuggestions({ input, labels: () => LABELS, suffix: () => '.dot', combobox, open }),
    dispose: d,
  }));
  flush();
  return {
    suggestions,
    open,
    dispose,
    listbox: () => combobox.listbox.get(),
    type(next: string): void {
      setInput({ ...input(), text: next });
      flush();
    },
    blur(): void {
      setInput({ ...input(), focused: false });
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
    view.dispose();
  });

  it('As a visitor, I leave the input and the suggestions hide', () => {
    // Given the suggestions for "a"
    const view = mount('a');

    // When
    view.blur();

    // Then
    expect(view.suggestions.shown()).toEqual([]);
    expect(view.listbox()).toBeNull();
    view.dispose();
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
    view.dispose();
  });

  it('As a visitor, I press ArrowUp on the first label and the active option wraps to the last', () => {
    // Given the first label active
    const view = mount('a');
    view.press('ArrowDown');

    // When
    view.press('ArrowUp');

    // Then
    expect(view.suggestions.active()).toBe('avocado');
    view.dispose();
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
    view.dispose();
  });

  it('As a visitor, I press Enter with no active label and the key is left to the form', () => {
    // Given the suggestions for "a", none active
    const view = mount('a');

    // When
    const taken = view.press('Enter');

    // Then
    expect(taken).toBe(false);
    expect(view.open).not.toHaveBeenCalled();
    view.dispose();
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
      view.dispose();
    },
  );

  it('As a visitor, I press Escape and the list hides until the text changes', () => {
    // Given the suggestions for "a"
    const view = mount('a');

    // When
    view.press('Escape');

    // Then
    expect(view.suggestions.shown()).toEqual([]);
    expect(view.listbox()).toBeNull();

    // When a character is typed
    view.type('ap');

    // Then
    expect(view.suggestions.shown()).toEqual(['apple']);

    // When it is deleted again
    view.type('a');

    // Then
    expect(view.suggestions.shown()).toEqual([]);
    view.dispose();
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
    view.dispose();
  });
});
