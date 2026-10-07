// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Free of imports so the Node-run Playwright specs can assert on it without loading the workspace barrels.

export const HOST_ERRORS = {
  FATAL_PANIC: 'The light client (smoldot) crashed unexpectedly.',
  SW_FAILED_TO_START: 'The light client failed to start on the shared worker.',
  SW_SYNC_TIMEOUT: "The light client couldn't sync in time on the shared worker.",
  SW_TIMED_OUT: 'The light client timed out during startup.',
  WORKER_INIT_TIMEOUT: 'The browser worker took too long to start.',
  HUB_SYNC_TIMEOUT: 'Light client timed out syncing to Asset Hub - no connection with peers.',
  LIGHT_CLIENT_TIMEOUT: 'The connection with other peers is too slow.',
  RPC_TIMEOUT: "The trusted provider didn't respond in time.",
  NETWORK_DROPPED: 'The connection to the network dropped while loading.',
  BITSWAP_NO_PEERS: 'No connected peers have the app files requested right now.',
  ARCHIVE_TRUNCATED: 'The download stopped before all the app files arrived.',
  ARCHIVE_NO_INDEX: 'This app was published without a start page.',
  MODULE_FETCH_FAILED: "Couldn't load app resources — reload to retry.",
  CHAIN_SPEC_REJECTED: "The light client couldn't load the chain configuration.",
  CONTENTHASH_UNSUPPORTED: "This domain's content format isn't supported.",
  MANIFEST_UNSUPPORTED_VERSION: "This app is published in a format dot.li doesn't support yet.",
  MANIFEST_INVALID: "This app's manifest is invalid, so dot.li can't tell how to open it.",
} as const;

export const FAILOVER_BTN_LABELS = {
  'rpc-gateway': 'Try Trusted Provider',
  'smoldot-shared-worker': 'Try Light Client',
} as const;

export const RELOAD_BTN_LABEL = 'Reload';

export const OPEN_SETTINGS_BTN_LABEL = 'Open Settings';

export const TRY_ANYWAY_BTN_LABEL = 'Try Anyway';

export const GO_BACK_BTN_LABEL = 'Go Back';

/** The title says which layer gave up, the `HOST_ERRORS` detail line below it says why. */
export const ERROR_TITLES = {
  HOST_UNAVAILABLE: 'Something went wrong on our side',
  /** The name never resolved, so there is nothing to download yet. */
  DOMAIN_UNREACHABLE: "Domain can't be reached",
  /** The name resolved, but the bytes went missing. */
  CONTENT_UNAVAILABLE: "This app couldn't be downloaded",
  /** The files arrived intact but are not a runnable app. */
  APP_UNUSABLE: "This app can't be opened",
} as const;
