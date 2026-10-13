// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's one scheduler of product notifications, shown as the page's own notifications.

import { createPageScheduledNotifications, type ScheduledNotifications } from './runtime/scheduled-notifications.js';
import { showNotification } from '@dotli/ui';

let page: ScheduledNotifications | null = null;

/** Built on first use, so importing this module reads no browser global. */
export function pageNotifications(): ScheduledNotifications {
  page ??= createPageScheduledNotifications(showNotification);
  return page;
}
