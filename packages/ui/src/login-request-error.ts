// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { VersionedHostRequestLoginError } from "@parity/truapi";

/**
 * Login call failure carrying the typed core error envelope. The bridge is
 * the single place that classifies rejection; consumers branch on
 * `rejected` instead of string-matching serialized errors.
 */
export class LoginRequestError extends Error {
  readonly error: VersionedHostRequestLoginError;

  constructor(error: VersionedHostRequestLoginError) {
    super(JSON.stringify(error));
    this.name = "LoginRequestError";
    this.error = error;
  }

  /** True when the core reported that the user rejected the login. */
  get rejected(): boolean {
    return this.error.value.value.reason === "Rejected";
  }
}
