// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/stores-solid';
import { modals, type ModalEntry } from '../../page/state/createModals.js';
import { PromptDialog } from './PromptDialog.js';

/** Shows the first dialog of the page's queue. Rendering it never throws. */
export function ModalOutlet(): JSX.Element {
  // The first entry, kept while only its view changes, so a handed-off dialog stays mounted.
  const first = useStore(modals.store, entries => entries[0], {
    equals: (previous, next) => previous?.id === next?.id,
  });
  return (
    <Show when={first()} keyed>
      {(entry: ModalEntry) => <PromptDialog entry={entry} />}
    </Show>
  );
}
