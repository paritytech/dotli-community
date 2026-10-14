// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A Vitest setup file. Tests run with metrics on, so a recorder nobody reads stays bound under every file and a test
// that binds its own restores to it.

import { bindRecordingSentry } from './index.js';

bindRecordingSentry();
