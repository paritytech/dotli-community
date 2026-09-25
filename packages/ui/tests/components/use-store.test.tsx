// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  createSyncStore,
  type ReadableStore,
} from "@dotli/ui/state/create-store";
import { useStore } from "@dotli/ui/components/use-store";
import { renderComponent, settle } from "../helpers/solid";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

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

  it("As a component, a set issued right after render and before the first flush is reflected once settled", async () => {
    // Given
    const store = createSyncStore("first");
    const view = renderComponent(() => <Label store={store} />);

    // When
    store.set("second");
    await settle();

    // Then
    expect(view.container.querySelector(".label")?.textContent).toBe("second");
  });

  it("As a component, a set dispatched from an owned scope like createRoot still reaches my mirror signal", async () => {
    // Given
    sentry.captureException.mockClear();
    const store = createSyncStore("first");
    const view = renderComponent(() => <Label store={store} />);
    await settle();

    // When
    createRoot((dispose) => {
      store.set("b");
      dispose();
    });
    await settle();

    // Then
    expect(view.container.querySelector(".label")?.textContent).toBe("b");
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a caller outside any reactive owner, useStore throws instead of leaking a subscription", () => {
    // Given
    const store = createSyncStore("x");

    // When / Then
    expect(() => useStore(store)).toThrow(
      "useStore must be called inside a component or reactive owner",
    );
  });
});
