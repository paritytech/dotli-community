// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// User-facing copy for the host's error surfaces. Kept free of imports so the
// Playwright specs, which run in Node, can assert on it without loading the
// workspace barrels that `errors.ts` needs.

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
  WALLET_IN_OTHER_TAB:
    'Only one tab can use the test wallet at a time, and the tab that has it did not hand it over. Close that tab, then reload this one.',
  WALLET_PAUSED: 'Paused: the test wallet is in use in another tab. Click or type here to use it in this tab.',
  WALLET_RESUMING: 'Moving the test wallet to this tab…',
} as const;

/**
 * Detail line for a host shell that shipped broken.
 *
 * The visitor cannot act on the missing node itself, and the site they asked
 * for is fine, so the copy points at us. Sentry gets the real reason from the
 * thrown error.
 */
export const HOST_UNAVAILABLE_DETAIL = "This page didn't load properly. Reloading usually fixes it.";

/**
 * Headlines for the full-page error surface.
 *
 * The title says which layer gave up, the detail below it says why, so these
 * stay separate from the `HOST_ERRORS` copy that fills the detail line.
 */
export const FAILOVER_BTN_LABELS = {
  'rpc-gateway': 'Try Trusted Provider',
  'smoldot-shared-worker': 'Try Light Client',
} as const;

export const RELOAD_BTN_LABEL = 'Reload';

export const OPEN_SETTINGS_BTN_LABEL = 'Open Settings';

export const TRY_ANYWAY_BTN_LABEL = 'Try Anyway';

export const GO_BACK_BTN_LABEL = 'Go Back';

/**
 * Headlines for the full-page error surface.
 *
 * The title says which layer gave up, the detail below it says why, so these
 * stay separate from the `HOST_ERRORS` copy that fills the detail line.
 */
export const ERROR_TITLES = {
  HOST_UNAVAILABLE: 'Something went wrong on our side',
  /** The name never resolved, so there is nothing to download yet. */
  DOMAIN_UNREACHABLE: "Domain can't be reached",
  /** The name resolved and the CID is known; the bytes are what went missing. */
  CONTENT_UNAVAILABLE: "This app couldn't be downloaded",
  /** The files arrived intact and are simply not a runnable app. */
  APP_UNUSABLE: "This app can't be opened",
  WALLET_IN_OTHER_TAB: 'Test wallet is open in another tab',
} as const;
