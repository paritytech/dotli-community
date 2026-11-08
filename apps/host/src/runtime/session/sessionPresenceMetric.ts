// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount } from '@dotli/metrics';

/**
 * Count. What the signed-in flag did to a stored sign-in as a reader went over it. Tagged `outcome`: `dropped` once for
 * each pass of the restore rule that dropped a stored session because the flag was gone, `unreadable` once per page
 * whose flag could not be read so session restore kept what it found, never for a preview its preview host frames,
 * whose flag reads unknown by design, and `error` for a saved session the store would not clear. Tagged `reason`, the
 * reader: `load` for a page's load, `visible` for an open page becoming visible, `window` for the sign-in or sign-out
 * window over the main store.
 */
export const sessionPresenceMetric = defineCount<'dropped' | 'error' | 'unreadable'>('session.presence');
