// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Toolchain proof for the Solid migration (sub-project 0). Not imported by any
// app code. Deleted in sub-project 1 once real components exist.

import { createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

export function SolidProbe(props: { label: string }): JSX.Element {
  const [count, setCount] = createSignal(0);
  return (
    <div>
      <button
        type="button"
        class={["solid-probe", { "solid-probe-used": count() > 0 }]}
        onClick={() => setCount((n) => n + 1)}
      >
        {props.label}: {count()}
      </button>
      <Show when={count() > 0}>
        <span>Tapped</span>
      </Show>
    </div>
  );
}
