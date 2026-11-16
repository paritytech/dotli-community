// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the suggestion island does beside rendering.

import { createEffect, createMemo, createSignal, onCleanup, onSettled, type Accessor } from 'solid-js';
import { useStore } from '@dotli/stores-solid';
import type { NavComboboxState, NavKey } from './navComboboxState.js';
import { typedName } from './dotUrl.js';
import { matchLabels } from './matchLabels.js';

type Params = {
  /** Every label the list may suggest. */
  labels: Accessor<readonly string[]>;
  /** True while more labels may still come. */
  loading: Accessor<boolean>;
  /** The TLD a typed name may end with. Null suggests nothing. */
  suffix: Accessor<string | null>;
  combobox: Pick<NavComboboxState, 'text' | 'focused' | 'showListbox' | 'handleKeys'>;
  /** Opens the name `label`. */
  open: (label: string) => void;
};

/**
 * The suggestions for the name input, for the owner's lifetime. They show while the input has focus, and Escape hides
 * them until the text changes. While labels still load and a name is typed, `loading` shows too, even with no match.
 * Once settled, the arrow keys move the active label, wrapping around, Enter opens it, and the input points at the list
 * while it shows.
 */
export function useSuggestions({ labels, loading, suffix, combobox, open }: Params): {
  shown: Accessor<readonly string[]>;
  active: Accessor<string | null>;
  loading: Accessor<boolean>;
} {
  const text = useStore(combobox.text);
  const focused = useStore(combobox.focused);
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
  const visible = createMemo(() => focused() && !escaped());
  const shown = createMemo<readonly string[]>(() => (visible() ? matches() : []));
  const typed = createMemo(() => {
    const tld = suffix();
    return tld !== null && typedName(text(), tld) !== '';
  });
  const shownLoading = createMemo(() => visible() && typed() && loading());
  const listShown = createMemo(() => shown().length > 0 || shownLoading());
  const active = createMemo(() => {
    const label = chosen();
    return label !== null && shown().includes(label) ? label : null;
  });

  createEffect(
    () => (listShown() ? { active: active() } : null),
    view => {
      combobox.showListbox(view);
    },
  );
  onCleanup(() => {
    combobox.showListbox(null);
  });

  function handleKey(key: NavKey): boolean {
    if (!listShown()) {
      return false;
    }
    if (key === 'Escape') {
      setEscaped(true);
      return true;
    }
    const list = shown();
    // The loading row alone has no option to move to or open.
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
    }
  }
  // Once in the browser, so a key the input gets before then stays with the form.
  onSettled(() => combobox.handleKeys(handleKey));

  return { shown, active, loading: shownLoading };
}
