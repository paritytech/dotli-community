// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A Shell.tsx look-alike with a `<For>` in its own markup, which must not
// lose its client templates (strip-client-templates-plugin.test.ts).

import { For } from "solid-js";
import type { JSX } from "@solidjs/web";

export function ForShell(): JSX.Element {
  return (
    <ul id="fixture-list">
      <For each={["a", "b"]}>{(item) => <li>{item()}</li>}</For>
      <li>static</li>
    </ul>
  );
}
