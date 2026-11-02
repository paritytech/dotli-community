// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, type ReadableStore } from '@dotli/shared';

const signingOut = createSyncStore<boolean>({ name: 'signingOut', initial: false });
const store: ReadableStore<boolean> = signingOut;

/** Whether the page's sign-out is waiting. */
export const signingOutState = {
  /** True while the page's sign-out waits for the sign-out window to read what it ends. */
  store,
  /** Publishes whether the page's sign-out is waiting for the sign-out window. Never throws. */
  set: signingOut.set,
};
