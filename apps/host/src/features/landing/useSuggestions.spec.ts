// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createRoot, createSignal, flush } from 'solid-js';
import { createNavComboboxState, type NavKey } from './navComboboxState.js';
import { useSuggestions } from './useSuggestions.js';

const LABELS = ['ant', 'apple', 'avocado', 'banana'];

type MountOptions = {
  loading?: boolean;
  /** The recently visited names, newest first. */
  visited?: readonly string[];
  /** The TLD a typed name may end with, null before the network is known. */
  suffix?: string | null;
  /** True for an input that held `initial` before it took focus, rather than one typed in after. */
  filledBeforeFocus?: boolean;
};

/** The suggestions under a fresh owner, over a focused input holding `initial`, settled. */
function mount(
  initial: string,
  { loading = false, visited = [], suffix = '.dot', filledBeforeFocus = false }: MountOptions = {},
) {
  const combobox = createNavComboboxState();
  if (filledBeforeFocus) {
    combobox.setText(initial);
  }
  const open = vi.fn();
  const [syncing, setSyncing] = createSignal(loading);
  const [recentLabels, setRecentLabels] = createSignal<readonly string[]>(visited);
  const forgotten: string[] = [];
  const recents = {
    labels: recentLabels,
    forget(label: string): void {
      forgotten.push(label);
      setRecentLabels(all => all.filter(l => l !== label));
    },
  };
  const { suggestions, dispose } = createRoot(d => ({
    suggestions: useSuggestions({
      labels: () => LABELS,
      recents,
      loading: syncing,
      suffix: () => suffix,
      combobox,
      open,
    }),
    dispose: d,
  }));
  onTestFinished(dispose);
  flush();
  // Focused, then typed in, unless the test asks for a field that took focus already filled.
  combobox.setFocused(true);
  flush();
  combobox.setText(initial);
  flush();
  return {
    suggestions,
    open,
    forgotten,
    listbox: () => combobox.listbox.get(),
    finishLoading(): void {
      setSyncing(false);
      flush();
    },
    type(next: string): void {
      combobox.setText(next);
      flush();
    },
    blur(): void {
      combobox.setFocused(false);
      flush();
    },
    focus(): void {
      combobox.setFocused(true);
      flush();
    },
    close(): void {
      suggestions.close();
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
  it('As a returning visitor, I focus the empty input and see my recent names, newest first, and no app labels', () => {
    // When
    const view = mount('', { visited: ['banana', 'zebra', 'ant'] });

    // Then
    expect(view.suggestions.recent()).toEqual(['banana', 'zebra', 'ant']);
    expect(view.suggestions.apps()).toEqual([]);
    expect(view.listbox()).toEqual({ active: null });
  });

  it('As a first-time visitor, I focus the empty input and no list shows', () => {
    // When
    const view = mount('');

    // Then
    expect(view.listbox()).toBeNull();
  });

  it('As a visitor typing in the focused input, I type the start of a name and see the matching app labels', () => {
    // Given the focused input, empty
    const view = mount('');

    // When
    view.type('a');

    // Then
    expect(view.suggestions.apps()).toEqual(['ant', 'apple', 'avocado']);
  });

  it('As a returning visitor before my network is known, I focus the input and see no suggestions', () => {
    // When
    const view = mount('al', { visited: ['alpha'], suffix: null });

    // Then
    expect(view.suggestions.recent()).toEqual([]);
    expect(view.suggestions.apps()).toEqual([]);
    expect(view.listbox()).toBeNull();
  });

  it('As a returning visitor, I press ArrowDown on the last recent and the first app label is active', () => {
    // Given the one matching recent active
    const view = mount('a', { visited: ['axe'] });
    view.press('ArrowDown');

    // When
    view.press('ArrowDown');

    // Then
    expect(view.suggestions.active()).toBe('ant');
  });

  it('As a returning visitor, I press Shift+Delete on the active recent, it is forgotten and the next option is active', () => {
    // Given the first of two recents active
    const view = mount('', { visited: ['axe', 'banana'] });
    view.press('ArrowDown');

    // When
    const taken = view.press('Shift+Delete');

    // Then
    expect(taken).toBe(true);
    expect(view.forgotten).toEqual(['axe']);
    expect(view.suggestions.recent()).toEqual(['banana']);
    expect(view.suggestions.active()).toBe('banana');
  });

  it('As a visitor, I press Shift+Delete on an active app label and the input keeps the key', () => {
    // Given an app label active
    const view = mount('a');
    view.press('ArrowDown');

    // When
    const taken = view.press('Shift+Delete');

    // Then
    expect(taken).toBe(false);
  });

  it('As a visitor, I leave the input and the suggestions hide', () => {
    // Given the suggestions for "a"
    const view = mount('a');

    // When
    view.blur();

    // Then
    expect(view.suggestions.apps()).toEqual([]);
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
    expect(view.listbox()).toEqual({ active: 'ant' });
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

  it('As a visitor with no list shown, I press ArrowDown and the form keeps it', () => {
    // Given text that matches nothing
    const view = mount('zebra');

    // When
    const taken = view.press('ArrowDown');

    // Then
    expect(taken).toBe(false);
  });

  it('As a visitor, I press Escape and the list hides', () => {
    // Given the suggestions for "a"
    const view = mount('a');

    // When
    view.press('Escape');

    // Then
    expect(view.suggestions.apps()).toEqual([]);
    expect(view.listbox()).toBeNull();
  });

  it('As a visitor, I dismiss the list from outside the input and it hides', () => {
    // Given the suggestions for "a"
    const view = mount('a');

    // When
    view.close();

    // Then
    expect(view.listbox()).toBeNull();
  });

  it('As a first-time visitor, I focus the input that already holds a name and no list shows until I type', () => {
    // Given an input filled with "a" before it took focus, and no recents
    const view = mount('a', { filledBeforeFocus: true });
    expect(view.listbox()).toBeNull();

    // When
    view.type('ap');

    // Then
    expect(view.suggestions.apps()).toEqual(['apple']);
  });

  it('As a returning visitor, I focus the input that already holds a name and see the suggestions', () => {
    // When
    const view = mount('a', { filledBeforeFocus: true, visited: ['avocado'] });

    // Then
    expect(view.suggestions.recent()).toEqual(['avocado']);
    expect(view.suggestions.apps()).toEqual(['ant', 'apple']);
  });

  it('As a returning visitor, I dismiss the list from outside the input, focus the input again and see my recent names', () => {
    // Given the list dismissed from outside, which takes focus from the input
    const view = mount('', { visited: ['banana', 'zebra'] });
    view.close();
    view.blur();

    // When
    view.focus();

    // Then
    expect(view.suggestions.recent()).toEqual(['banana', 'zebra']);
    expect(view.listbox()).toEqual({ active: null });
  });

  it('As a visitor, I press Escape and type a character and the list shows again', () => {
    // Given the list hidden by Escape at "a"
    const view = mount('a');
    view.press('Escape');

    // When
    view.type('ap');

    // Then
    expect(view.suggestions.apps()).toEqual(['apple']);
  });

  it('As a visitor, I press Escape, type a character and delete it, and the list stays shown', () => {
    // Given the list hidden by Escape at "a", then shown at "ap"
    const view = mount('a');
    view.press('Escape');
    view.type('ap');

    // When
    view.type('a');

    // Then
    expect(view.suggestions.apps()).toEqual(['ant', 'apple', 'avocado']);
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
    expect(view.listbox()).toEqual({ active: null });
  });

  it('As a visitor typing a name no label matches while the labels load, I see the list open to show the loading', () => {
    // Given the focused input, empty, while the labels load
    const view = mount('', { loading: true });

    // When
    view.type('zebra');

    // Then
    expect(view.suggestions.loading()).toBe(true);
    expect(view.listbox()).toEqual({ active: null });
  });

  it('As a visitor typing only a space while the labels load, I see no loading', () => {
    // Given the focused input, empty, while the labels load
    const view = mount('', { loading: true });

    // When
    view.type(' ');

    // Then
    expect(view.suggestions.loading()).toBe(false);
    expect(view.listbox()).toBeNull();
  });

  it('As a visitor typing a name no label matches, I see the list close once the labels finish loading', () => {
    // Given a name no label matches while the labels load
    const view = mount('zebra', { loading: true });

    // When
    view.finishLoading();

    // Then
    expect(view.suggestions.loading()).toBe(false);
    expect(view.listbox()).toBeNull();
  });

  it('As a visitor typing a name no label matches while the labels load, I press Escape and the loading hides', () => {
    // Given
    const view = mount('zebra', { loading: true });

    // When
    const taken = view.press('Escape');

    // Then
    expect(taken).toBe(true);
    expect(view.suggestions.loading()).toBe(false);
    expect(view.listbox()).toBeNull();
  });

  it('As a visitor typing a name no label matches while the labels load, I press Enter and the form keeps it', () => {
    // Given
    const view = mount('zebra', { loading: true });

    // When
    const taken = view.press('Enter');

    // Then
    expect(taken).toBe(false);
  });
});
