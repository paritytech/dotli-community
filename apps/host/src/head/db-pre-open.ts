// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Inline in the product page's head, so the database opens while the HTML still parses.

import { preOpenDotliDb } from '@dotli/storage';

preOpenDotliDb(window, indexedDB);
