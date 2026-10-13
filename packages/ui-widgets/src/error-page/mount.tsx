// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded error page chunk. Only the error page's loader imports it.

import { mountScreen } from '../mount-screen.js';
import type { ScreenSlot } from '../page-screen.js';
import type { ErrorPageContent } from './error-page.js';
import { ErrorPage } from './ErrorPage.js';

export function mountErrorPage(slot: ScreenSlot, page: ErrorPageContent): void {
  mountScreen(slot, () => <ErrorPage page={page} standalone={slot.standalone} />);
}
