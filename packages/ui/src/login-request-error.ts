// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { VersionedHostRequestLoginError } from "@parity/truapi";

export class LoginRequestError extends Error {
  readonly error: VersionedHostRequestLoginError;

  constructor(error: VersionedHostRequestLoginError) {
    super(JSON.stringify(error));
    this.name = "LoginRequestError";
    this.error = error;
  }
}
