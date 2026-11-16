// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount } from '@dotli/metrics';
import type { WindowSignOutOutcome } from './signOutInWindow.js';

/**
 * Count. How the sign-out window's own sign-out ended. Tagged `outcome`: `told_phone` for a paired session it ended on
 * its own core, `cleared` for a store it cleared without telling the phone, `nothing` for a store that held nothing,
 * `kept` for a signed-in flag still set or unreadable, or set again by a sign-in elsewhere before the window cleared,
 * so it left the store as it found it, and `error` for a step that failed while it still cleared what it could, or a
 * boot that failed before it could sign out, which its own issue tells apart. Tagged `reason`, whether the page told
 * the phone itself (`notified, unnotified`). An answer to the page that failed counts once more, apart from how the
 * sign-out ended, as `error` with `answer`.
 */
export const sessionWindowSignoutResultMetric = defineCount<WindowSignOutOutcome>('session_window.signout_result');
