// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ShieldState } from "../verification-shield.js";
import {
  createSyncStore,
  shallowEqual,
  type ReadableStore,
} from "./create-store.js";

/**
 * What the topbar's URL pill shows. `none` is the landing page (and the
 * prerendered shell): an empty `#topbar-url`, hidden by CSS. `shield` is null
 * until the host knows how the product was loaded.
 */
export type UrlPillState =
  | { kind: "none" }
  | { kind: "localhost"; host: string }
  | {
      kind: "product";
      domain: string;
      tld: string;
      shield: ShieldState | null;
    };

const urlPill = createSyncStore<UrlPillState>(
  { kind: "none" },
  { equals: shallowEqual },
);

export const urlPillStore: ReadableStore<UrlPillState> = urlPill;

/** A local product (localhost proxy or preview route) served from `host`. */
export function showLocalhostPill(host: string): void {
  urlPill.set({ kind: "localhost", host });
}

/** A `.dot` product: `domain` is its label, `tld` the active TLD suffix. */
export function showProductPill(domain: string, tld: string): void {
  urlPill.set({ kind: "product", domain, tld, shield: null });
}

/**
 * Swap the shield's glyph, colour, label and "This site" row to match
 * `state`. Only a product pill has a shield; otherwise this does nothing.
 */
export function setVerificationShieldState(state: ShieldState): void {
  const current = urlPill.get();
  if (current.kind === "product") {
    urlPill.set({ ...current, shield: state });
  }
}

/** Back to the empty URL bar. Tests only: the host never resets the pill. */
export function resetUrlPill(): void {
  urlPill.set({ kind: "none" });
}
