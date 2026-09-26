// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A Shell.tsx look-alike with a `<Show>` in its own markup, which must not
// lose its client templates (strip-client-templates-plugin.test.ts).

import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";

export function ShowShell(props: { open: boolean }): JSX.Element {
  return (
    <div id="fixture-bar">
      <Show when={props.open}>
        <p class="fixture-shown">shown</p>
      </Show>
      <span>static</span>
    </div>
  );
}
