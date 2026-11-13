// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the suggestion island does beside rendering.

import { createEffect, createMemo, createSignal, onCleanup, onSettled, type Accessor } from 'solid-js';
import type { NavComboboxState, NavKey } from '../state/navComboboxState.js';
import { matchLabels } from '../components/landing/matchLabels.js';
import { getSuggestionId, SUGGESTIONS_ID } from '../components/landing/suggestionIds.js';

type Params = {
  /** What the visitor typed. */
  text: Accessor<string>;
  /** Whether the input has focus. */
  focused: Accessor<boolean>;
  /** Every label the list may suggest. */
  labels: Accessor<readonly string[]>;
  /** The TLD a typed name may end with. Null suggests nothing. */
  suffix: Accessor<string | null>;
  combobox: Pick<NavComboboxState, 'showListbox' | 'handleKeys'>;
  /** Opens the name `label`. */
  open: (label: string) => void;
};

/**
 * The suggestions for the name input, for the owner's lifetime. They show while the input has focus, and Escape hides
 * them until the text changes. Once settled, the arrow keys move the active label, wrapping around, Enter opens it,
 * and the input points at the list while it shows.
 */
export function useSuggestions({ text, focused, labels, suffix, combobox, open }: Params): {
  shown: Accessor<readonly string[]>;
  active: Accessor<string | null>;
} {
  const matches = createMemo(() => matchLabels(labels(), text(), suffix()));
  // Escape and a chosen label each last until the text changes, so they read the text only to reset on it.
  const [escaped, setEscaped] = createSignal(() => {
    text();
    return false;
  });
  const [chosen, setChosen] = createSignal<string | null>(() => {
    text();
    return null;
  });
  const shown = createMemo<readonly string[]>(() => (focused() && !escaped() ? matches() : []));
  const active = createMemo(() => {
    const label = chosen();
    return label !== null && shown().includes(label) ? label : null;
  });

  createEffect(
    () => {
      if (shown().length === 0) {
        return null;
      }
      const label = active();
      return { id: SUGGESTIONS_ID, activeId: label === null ? null : getSuggestionId(label) };
    },
    view => {
      combobox.showListbox(view);
    },
  );
  onCleanup(() => {
    combobox.showListbox(null);
  });

  function handleKey(key: NavKey): boolean {
    const list = shown();
    if (list.length === 0) {
      return false;
    }
    const label = active();
    const index = label === null ? -1 : list.indexOf(label);
    switch (key) {
      case 'ArrowDown':
        setChosen(list[(index + 1) % list.length] ?? null);
        return true;
      case 'ArrowUp':
        setChosen(list[index <= 0 ? list.length - 1 : index - 1] ?? null);
        return true;
      case 'Enter':
        if (label === null) {
          return false;
        }
        open(label);
        return true;
      case 'Escape':
        setEscaped(true);
        return true;
    }
  }
  // Once in the browser, so a key the input gets before then stays with the form.
  onSettled(() => combobox.handleKeys(handleKey));

  return { shown, active };
}
