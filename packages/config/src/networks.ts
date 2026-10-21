// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The network table and its names. It reads no page state at load, so Node tooling imports it where the bare entry
// cannot load.

export { isValidNetwork, NETWORK_NAME_TO_SERVICES_CONFIG, NetworkName, type Network } from './network.js';
