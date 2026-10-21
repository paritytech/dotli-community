// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a context that never receives the runtime network config may read, such as the protocol worker that serves
// every tab: readers of the fields no override can change, and values that do not depend on the network config. A name
// joins only once it reads no overridable field, directly or through a helper.

export { DEBUG } from './config.js';
export {
  CHAIN_ROLES,
  chainRoleForGenesis,
  getActiveFixedServicesConfig,
  getActiveSupportedGenesisHashes,
  isValidNetwork,
  type ChainRole,
  type FixedServicesConfig,
  type Network,
} from './network.js';
