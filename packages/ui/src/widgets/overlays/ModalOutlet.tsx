// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { useStore } from '../../components/use-store.js';
import { modalsStore, type ModalEntry } from '../../page/state/modals.js';
import { PromptDialog } from './PromptDialog.js';

export function ModalOutlet(): JSX.Element {
  const entries = useStore(modalsStore);
  return (
    <Show when={entries()[0]} keyed>
      {(entry: ModalEntry) => <PromptDialog entry={entry} />}
    </Show>
  );
}
