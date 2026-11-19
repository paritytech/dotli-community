// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the suggestion island does beside rendering.

import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack, type Accessor } from 'solid-js';
import { useStore } from '@dotli/stores-solid';
import type { NavComboboxState, NavKey } from './navComboboxState.js';
import type { Recents } from './landing.js';
import { typedName } from './dotUrl.js';
import { matchSuggestions } from './matchSuggestions.js';

type Params = {
  /** Every app label the list may suggest. */
  labels: Accessor<readonly string[]>;
  /** The recently visited names, newest first, and a way to forget one. */
  recents: Recents;
  /** True while more labels may still come. */
  loading: Accessor<boolean>;
  /** The TLD a typed name may end with. Null suggests nothing. */
  suffix: Accessor<string | null>;
  combobox: Pick<NavComboboxState, 'text' | 'focused' | 'showListbox' | 'handleKeys'>;
  /** Opens the name `label`. */
  open: (label: string) => void;
};

const NO_MATCHES: ReturnType<typeof matchSuggestions> = { recent: [], apps: null };

/**
 * The suggestions for the name input, for the owner's lifetime, in two sections. `recent` holds the recents that start
 * with the typed name, newest first, so an empty input shows the newest. `apps` holds the app labels that match it, less
 * any recent. They show while the input has focus, once there is at least one recent or the input was typed in since it
 * took focus. Escape hides them until the text changes or the input takes focus again. While labels still load and a
 * name is typed, `loading` shows too, even with no match. Once settled, the arrow keys move the active label
 * through both sections, wrapping around, Enter opens it, Shift+Delete forgets it when it is a recent, and the input
 * points at the list while it shows. `close` hides them as Escape does.
 */
export function useSuggestions({ labels, recents, loading, suffix, combobox, open }: Params): {
  recent: Accessor<readonly string[]>;
  apps: Accessor<readonly string[]>;
  active: Accessor<string | null>;
  loading: Accessor<boolean>;
  close: () => void;
} {
  const text = useStore(combobox.text);
  const focused = useStore(combobox.focused);
  const matches = createMemo(() => {
    const tld = suffix();
    return tld === null
      ? NO_MATCHES
      : matchSuggestions({ name: typedName(text(), tld), recents: recents.labels(), apps: labels() });
  });
  // Escape lasts until the text changes or the input takes focus again, and a chosen label until the text changes, so
  // they read those only to reset on them.
  const [escaped, setEscaped] = createSignal(() => {
    text();
    focused();
    return false;
  });
  const [chosen, setChosen] = createSignal<string | null>(() => {
    text();
    return null;
  });
  // The text as the input took focus. Focus alone opens the list only when there is a recent to show, and typing opens it.
  const focusedText = createMemo(() => (focused() ? untrack(text) : null));
  const visible = createMemo(
    () => focused() && !escaped() && (text() !== focusedText() || recents.labels().length > 0),
  );
  const recent = createMemo<readonly string[]>(() => (visible() ? matches().recent : []));
  const apps = createMemo<readonly string[]>(() => (visible() ? (matches().apps ?? []) : []));
  // The one order the arrow keys walk.
  const shown = createMemo(() => [...recent(), ...apps()]);
  // The loading row belongs to the apps section, so it shows only where that section applies.
  const shownLoading = createMemo(() => visible() && matches().apps !== null && loading());
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
      case 'Shift+Delete':
        return forgetActive(list, index);
    }
  }

  // Forgets the active option when it is a recent, and returns whether it did.
  function forgetActive(list: readonly string[], index: number): boolean {
    const label = list[index];
    if (label === undefined || !recent().includes(label)) {
      return false;
    }
    recents.forget(label);
    // The option that takes its place becomes active, so the keys go on from there.
    setChosen(list[index + 1] ?? list[index - 1] ?? null);
    return true;
  }
  // Once in the browser, so a key the input gets before then stays with the form.
  onSettled(() => combobox.handleKeys(handleKey));

  return {
    recent,
    apps,
    active,
    loading: shownLoading,
    close: () => {
      setEscaped(true);
    },
  };
}
