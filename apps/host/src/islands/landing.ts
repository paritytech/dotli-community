// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onSettled, untrack, type Accessor } from 'solid-js';
import { getActiveTldSuffix } from '@dotli/config';
import type { RecentLabels } from '../recent-labels.js';

/**
 * The TLD the visitor's network registers names under. The visitor's network decides it, so the browser reads it once
 * settled and the build renders null.
 */
export function useActiveTld(read: () => string = getActiveTldSuffix): Accessor<string | null> {
  const [suffix, setSuffix] = createSignal<string | null>(null);
  onSettled(() => {
    setSuffix(read());
  });
  return suffix;
}

/** The recently visited names and a way to forget one, for an island's own lifetime. */
export interface Recents {
  labels: Accessor<readonly string[]>;
  forget: (label: string) => void;
}

/**
 * Loads the recents once settled, from the store `open` gives, if any. The build renders this too and has no store to
 * reach, so it renders none. A forgotten name leaves the list at once, without waiting for the store.
 */
export function useRecents(open: () => RecentLabels | undefined): Recents {
  const [labels, setLabels] = createSignal<readonly string[]>([]);
  let recents: RecentLabels | undefined;
  onSettled(() => {
    recents = untrack(open);
    void recents?.load().then(loaded => {
      setLabels(loaded);
    });
  });
  return {
    labels,
    forget: label => {
      void recents?.forget(label);
      setLabels(all => all.filter(l => l !== label));
    },
  };
}
