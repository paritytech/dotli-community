// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show, useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ModalFocusFallback } from '../../components/floating/layer-context.js';
import { useStore } from '../../components/use-store.js';
import { modalsStore, type ModalEntry } from '../../page/state/modals.js';
import { PromptDialog } from './PromptDialog.js';

export function ModalOutlet(): JSX.Element {
  const entries = useStore(modalsStore);
  // A dialog that names no fallback keeps the page's.
  const inherited = useContext(ModalFocusFallback);
  return (
    <Show when={entries()[0]} keyed>
      {(entry: ModalEntry) => (
        <ModalFocusFallback value={entry.focusFallback ?? inherited}>
          <PromptDialog entry={entry} />
        </ModalFocusFallback>
      )}
    </Show>
  );
}
