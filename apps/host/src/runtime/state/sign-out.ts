// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, type ReadableStore } from '@dotli/shared';

// Written only by the page's sign-out, which reports here while it waits for the sign-out window.
const signingOut = createSyncStore<boolean>('signingOut', false);

/** True while the page's sign-out waits for the sign-out window to read what it ends. */
export const signingOutStore: ReadableStore<boolean> = signingOut;

export function setSigningOut(pending: boolean): void {
  signingOut.set(pending);
}
