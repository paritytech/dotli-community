// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, type ReadableAtom } from 'nanostores';

export type NavKey = 'ArrowDown' | 'ArrowUp' | 'Enter' | 'Escape';

/** The suggestions the input controls: the listbox's id and its active option's id. */
export type ListboxView = { id: string; activeId: string | null };

export type NavComboboxState = ReturnType<typeof createNavComboboxState>;

/** The landing name input and the suggestions it controls, shared by the two islands that render them. */
export const navComboboxState = createNavComboboxState();

/** Creates the state the name input and its suggestions share. */
export function createNavComboboxState() {
  const text = atom('');
  const textStore: ReadableAtom<string> = text;
  const focused = atom(false);
  const focusedStore: ReadableAtom<boolean> = focused;
  const listbox = atom<ListboxView | null>(null);
  const listboxStore: ReadableAtom<ListboxView | null> = listbox;
  let keyHandler: ((key: NavKey) => boolean) | null = null;

  return {
    /** What the visitor typed. */
    text: textStore,
    /** Whether the input has focus. */
    focused: focusedStore,
    /** The suggestions the input controls, or null while none show. */
    listbox: listboxStore,
    setText(value: string): void {
      text.set(value);
    },
    setFocused(value: boolean): void {
      focused.set(value);
    },
    showListbox(view: ListboxView | null): void {
      listbox.set(view);
    },
    /**
     * Offers a key the input received to the suggestions, and returns whether they took it. Returns false while no
     * handler is registered, so the form keeps the key. Rethrows what the handler throws.
     */
    press(key: NavKey): boolean {
      return keyHandler ? keyHandler(key) : false;
    },
    /**
     * Registers the handler that answers `press`, in place of any earlier one. The cleanup removes only this handler,
     * so a late cleanup leaves a newer one in place, and calling it again does nothing.
     */
    handleKeys(handler: (key: NavKey) => boolean): () => void {
      keyHandler = handler;
      return () => {
        if (keyHandler === handler) {
          keyHandler = null;
        }
      };
    },
  };
}
