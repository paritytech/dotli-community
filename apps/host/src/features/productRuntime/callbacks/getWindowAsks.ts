// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HostAsks } from './createHostCallbacks.js';

/**
 * Answers the session window core's asks without showing a prompt or storing a decision. Every answer resolves to an
 * allow, and none rejects.
 *
 * Opening the window and approving the action in it is the user's permission, so nothing is asked again or stored.
 */
export function getWindowAsks(): ReturnType<HostAsks> {
  return {
    permissions: {
      remotePermission: () => Promise.resolve('AllowOnce'),
      devicePermission: () => Promise.resolve('AllowOnce'),
    },
    userConfirmation: {
      confirmUserAction: () => Promise.resolve(true),
      confirmPermission: () => Promise.resolve('AllowOnce'),
    },
  };
}
