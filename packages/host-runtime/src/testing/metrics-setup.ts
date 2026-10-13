// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Tests run with metrics on. A recorder nobody reads stays bound under every file, so a test that binds its own
// restores to it, and no test prints the unbound warning.

import { bindRecordingSentry } from '@dotli/metrics/testing';

bindRecordingSentry();
