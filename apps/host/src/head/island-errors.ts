// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Inline in the head of every host page, so it listens before the first island hydrates.

import { queueIslandErrors } from '../island-error-queue.js';

queueIslandErrors(window, window);
