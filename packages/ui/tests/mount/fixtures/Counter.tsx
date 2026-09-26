// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The reactive child of IslandShell.tsx: counts clicks, and throws once
// asked to (island.test.tsx).

import { createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";

let breakCounter = (): void => undefined;

/** Makes the mounted Counter throw on its next update. */
export function breakMountedCounter(): void {
  breakCounter();
}

export function Counter(): JSX.Element {
  const [count, setCount] = createSignal(0);
  const [broken, setBroken] = createSignal(false);
  breakCounter = () => setBroken(true);
  return (
    <button
      id="fixture-counter"
      type="button"
      onClick={() => setCount((n) => n + 1)}
    >
      {(() => {
        if (broken()) {
          throw new Error("the counter island broke");
        }
        return String(count());
      })()}
    </button>
  );
}
