// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { JSX } from "@solidjs/web";
import {
  createSyncStore,
  type ReadableStore,
} from "@dotli/ui/state/create-store";
import { useStore } from "@dotli/ui/components/use-store";
import { renderComponent, settle } from "../helpers/solid";

function Label(props: { store: ReadableStore<string> }): JSX.Element {
  const value = useStore(props.store);
  return <span class="label">{value()}</span>;
}

describe("useStore", () => {
  it("As a component, I render the store's value and re-render after it changes", async () => {
    // Given
    const store = createSyncStore("first");
    const view = renderComponent(() => <Label store={store} />);
    expect(view.container.querySelector(".label")?.textContent).toBe("first");

    // When
    store.set("second");
    await settle();

    // Then
    expect(view.container.querySelector(".label")?.textContent).toBe("second");
  });

  it("As a component, unmounting unsubscribes me from the store", async () => {
    // Given
    const store = createSyncStore("x");
    let active = 0;
    const counted: ReadableStore<string> = {
      get: store.get,
      subscribe: (listener) => {
        active += 1;
        const off = store.subscribe(listener);
        return () => {
          active -= 1;
          off();
        };
      },
    };
    const view = renderComponent(() => <Label store={counted} />);
    await settle();
    expect(active).toBe(1);

    // When
    view.unmount();

    // Then
    expect(active).toBe(0);
  });
});
