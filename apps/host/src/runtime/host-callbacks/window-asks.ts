// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HostAsks } from './handlers.js';

/**
 * Answers the session window core's asks without showing a prompt or storing a decision.
 *
 * Opening the window and approving the action in it is the user's permission, so nothing is asked again or stored.
 */
export const windowAsks: HostAsks = () => ({
  permissions: {
    remotePermission: () => Promise.resolve('AllowOnce'),
    devicePermission: () => Promise.resolve('AllowOnce'),
  },
  userConfirmation: {
    confirmUserAction: () => Promise.resolve(true),
    confirmPermission: () => Promise.resolve('AllowOnce'),
  },
});
