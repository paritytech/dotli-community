// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { urlPillStore, type UrlPillState } from "../../state/url-pill.js";
import { useStore } from "../use-store.js";
import { VerificationShield } from "./VerificationShield.js";

type Pill<K extends UrlPillState["kind"]> = Extract<UrlPillState, { kind: K }>;

/**
 * The topbar's URL bar (`#topbar-url`), a shell island (see islands.tsx):
 * Shell.tsx prerenders it empty, which is also what the url-pill store's
 * default renders, and this component is swapped in for it after boot. The
 * host (main.ts) writes the store, possibly before the island mounts, so it
 * renders whatever the store holds when it mounts.
 *
 * A local product shows its host beside a terminal icon (`.localhost-pill`);
 * a `.dot` product shows its label and TLD beside the verification shield.
 * The URL bar stays childless otherwise, so `.topbar-url:empty` hides it.
 * Product strings render as text.
 */
export function UrlPill(): JSX.Element {
  const state = useStore(urlPillStore);
  const localhost = (): Pill<"localhost"> | undefined => {
    const s = state();
    return s.kind === "localhost" ? s : undefined;
  };
  const product = (): Pill<"product"> | undefined => {
    const s = state();
    return s.kind === "product" ? s : undefined;
  };

  return (
    <div class="topbar-url" id="topbar-url">
      <Show
        when={localhost()}
        fallback={
          <Show when={product()}>
            {(pill) => (
              <div class="topbar-url-pill" id="url-pill">
                <VerificationShield state={pill().shield} />
                <span class="topbar-url-text">
                  <span class="dot-domain">{pill().domain}</span>
                  <span class="dot-tld">{pill().tld}</span>
                </span>
              </div>
            )}
          </Show>
        }
      >
        {(pill) => (
          <div class="topbar-url-pill localhost-pill" id="url-pill">
            <svg
              class="localhost-icon"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span class="topbar-url-text">
              <span class="dot-domain">{pill().host}</span>
            </span>
          </div>
        )}
      </Show>
    </div>
  );
}
