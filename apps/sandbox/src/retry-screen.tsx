// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The screen the sandbox shows while it reloads a product whose connection dropped.

import { showScreen } from '@dotli/ui-widgets';
import { RetryScreen } from './RetryScreen.js';

export function showRetryScreen(): void {
  showScreen(standalone => <RetryScreen standalone={standalone} />);
}
