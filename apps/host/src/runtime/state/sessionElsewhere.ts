// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, type ReadableStore } from '@dotli/shared';

// Written only by session state, which knows both what the page holds and what the signed-in flag last said.
const elsewhere = createSyncStore<boolean>('sessionElsewhere', false);

/**
 * True while the page shows signed out and the signed-in flag says a sign-in exists on the site, as in Safari, where a
 * page keeps its own copy and never sees a sign-in made on another product.
 */
export const sessionElsewhereStore: ReadableStore<boolean> = elsewhere;

export function setSessionElsewhere(next: boolean): void {
  elsewhere.set(next);
}
