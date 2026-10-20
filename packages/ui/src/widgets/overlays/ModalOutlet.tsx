// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { useStore } from '../../components/use-store.js';
import { modalsStore, type ModalEntry } from '../../page/state/modals.js';
import { PromptDialog } from './PromptDialog.js';

export function ModalOutlet(): JSX.Element {
  // The first entry, kept while only its view changes, so a handed-off dialog stays mounted.
  const first = useStore(
    modalsStore,
    entries => entries[0],
    (prev, next) => prev?.id === next?.id,
  );
  return (
    <Show when={first()} keyed>
      {(entry: ModalEntry) => <PromptDialog entry={entry} />}
    </Show>
  );
}
