// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import { topbarStore } from "../../state/topbar";
import { useStore } from "../use-store";

/**
 * The topbar's offline banner (`#offline-banner`), a shell island (see
 * islands.tsx): Shell.tsx prerenders it hidden as the last child of
 * `#topbar`, and this component is swapped in for it after boot, applying
 * the real state straight away. It shows while the browser reports being
 * offline and the topbar is visible, so it rides the topbar's auto-hide
 * instead of dangling into the viewport. As a PWA the host boots from the
 * service worker cache, so losing the connection is otherwise invisible.
 *
 * Not focusable and not clickable: it is a status live region only, so it is
 * none of the islands loader's click triggers.
 */
export function OfflineBanner(): JSX.Element {
  const topbar = useStore(topbarStore);
  const [online, setOnline] = createSignal(navigator.onLine);
  const update = (): void => {
    setOnline(navigator.onLine);
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  onCleanup(() => {
    window.removeEventListener("online", update);
    window.removeEventListener("offline", update);
  });

  return (
    <div
      id="offline-banner"
      role="status"
      aria-live="polite"
      style={{
        position: "absolute",
        top: "100%",
        left: "0",
        right: "0",
        "z-index": "999",
        background: "#b45309",
        color: "#fff",
        "font-size": "0.75rem",
        "font-weight": "500",
        "text-align": "center",
        padding: "4px 12px",
        "letter-spacing": "0.02em",
        display: !online() && topbar().visible ? "block" : "none",
      }}
    >
      You are offline
    </div>
  );
}
