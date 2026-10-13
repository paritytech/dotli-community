// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shield state a story gives the shield views. Plays move it the way the page's product load does.

import { createSignal } from 'solid-js';
import type { ShieldState } from '../src/state/url-pill.js';

const [shield, setShieldSignal] = createSignal<ShieldState | null | undefined>(undefined);

/** Undefined while the pill is no product's, null until the host knows how the product loaded. */
export const storyShield = shield;

/** The shield as its view reads it once a product's pill shows. */
export const storyShieldState = (): ShieldState | null => shield() ?? null;

/** No product's pill: none yet, or a localhost proxy. */
export function noProductPill(): void {
  setShieldSignal(undefined);
}

/** A product's pill, before the host knows how the product loaded. */
export function productPill(): void {
  setShieldSignal(null);
}

/** How the product loaded, as the host learns it. */
export function setShield(state: ShieldState): void {
  setShieldSignal(state);
}
