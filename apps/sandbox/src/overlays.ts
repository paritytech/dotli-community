// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's one set of toast and dialog overlays, reporting through the sandbox's metrics.

import { createPageOverlays } from '@dotli/ui-widgets';
import { uiReporter } from './ui-reporter.js';

const overlays = createPageOverlays(uiReporter);

export const prefetchOverlays = overlays.prefetch;

export const presentModal = overlays.presentModal;

export const showNotification = overlays.showNotification;
