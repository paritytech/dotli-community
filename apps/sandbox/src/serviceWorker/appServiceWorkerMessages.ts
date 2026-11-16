// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The `type` of each message the page and its app service worker exchange. */
export const APP_SERVICE_WORKER_MESSAGES = {
  /** The page asks a waiting worker to take control of its clients now. */
  CLAIM: 'SW_CLAIM_EVENT',
  /** The page asks the worker which build it runs. */
  GET_VERSION: 'GET_SW_VERSION',
  /** The worker answers the page with the build it runs. */
  VERSION: 'SW_VERSION',
  /** The page hands the worker the packed archive to serve. */
  SET_ARCHIVE: 'SET_ARCHIVE',
  /** The worker serves the archive the page handed it. */
  ARCHIVE_READY: 'ARCHIVE_READY',
  /** The worker refuses the archive the page handed it, with a reason. */
  ARCHIVE_ERROR: 'ARCHIVE_ERROR',
  /** The worker could not keep the archive for a restart, or read it back after one. */
  ARCHIVE_FAILURE: 'ARCHIVE_FAILURE',
} as const;
