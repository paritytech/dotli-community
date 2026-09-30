// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { useStore } from '../../src/components/use-store.js';
import { createSyncStore } from '../../src/state/create-store.js';

/** What the label shows, and whether it is marked. */
export const labelStore = createSyncStore({ text: 'build', marked: false });

/** The store's text, and a mark while it is marked: an island's store read. */
export function StoreLabel(): JSX.Element {
  const text = useStore(labelStore, s => s.text);
  const marked = useStore(labelStore, s => s.marked);
  return (
    <p class="store-label" data-marked={marked() ? '' : undefined}>
      <span class="text">{text()}</span>
      <Show when={marked()}>
        <b class="mark">marked</b>
      </Show>
    </p>
  );
}
