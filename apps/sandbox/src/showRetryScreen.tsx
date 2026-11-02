// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The screen the sandbox shows while it reloads a product whose connection dropped.

import { pageScreen } from '@dotli/ui';
import { RetryScreen } from './RetryScreen.js';

/** Shows the retry screen in place of the page's content, replacing any screen shown before. Never throws. */
export function showRetryScreen(): void {
  pageScreen.show(standalone => <RetryScreen standalone={standalone} />);
}
