// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Inline at the top of the product's HTML, so it wraps the APIs before any product script runs.

import { installSandboxChecker, reportToParent } from './checker.js';

installSandboxChecker(window, reportToParent(window));
