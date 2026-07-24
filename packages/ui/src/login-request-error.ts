// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { VersionedHostRequestLoginError } from "@parity/truapi";
import type { CallErrorValue } from "@parity/truapi/scale";

type LoginRequestFailure = CallErrorValue<VersionedHostRequestLoginError>;

export class LoginRequestError extends Error {
  readonly error: LoginRequestFailure;

  constructor(error: LoginRequestFailure) {
    super(formatLoginRequestError(error));
    this.name = "LoginRequestError";
    this.error = error;
  }
}

function formatLoginRequestError(error: LoginRequestFailure): string {
  switch (error.tag) {
    case "Domain":
      return formatDomainLoginError(error.value);
    case "Denied":
      return "Login request denied";
    case "Unsupported":
      return "Login is not supported by this host";
    case "MalformedFrame":
    case "HostFailure":
      return error.value.reason;
  }
}

function formatDomainLoginError(error: VersionedHostRequestLoginError): string {
  return error.value.value.reason;
}
