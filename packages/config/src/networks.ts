// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The network table and its names. It reads no page state at load, so Node tooling imports it where the bare entry
// cannot load.

export type { Network } from './networkNames.js';
export { NETWORK_NAMES, isValidNetwork } from './networkNames.js';
export { NETWORK_NAME_TO_SERVICES_CONFIG } from './networkServices.js';
