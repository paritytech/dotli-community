// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's error page, reporting through the sandbox's metrics.

import { createErrorPage } from '@dotli/ui-widgets';
import { uiReporter } from './ui-reporter.js';

export const { showError } = createErrorPage(uiReporter);
