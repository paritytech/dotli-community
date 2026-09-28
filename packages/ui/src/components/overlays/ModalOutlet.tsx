// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { modalsStore, type ModalEntry } from "../../state/modals";
import { useStore } from "../use-store";
import { SigningDialog } from "./SigningDialog";

/** Shows the first queued dialog; the rest wait their turn. */
export function ModalOutlet(): JSX.Element {
  const entries = useStore(modalsStore);
  return (
    <Show when={entries()[0]} keyed>
      {(entry: ModalEntry) => <SigningDialog entry={entry} />}
    </Show>
  );
}
