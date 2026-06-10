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

  get rejected(): boolean {
    return isLoginCancellation(this.error);
  }
}

export function isLoginCancellation(error: unknown): boolean {
  if (isRejectedString(error)) {
    return true;
  }
  if (error instanceof LoginRequestError) {
    return isLoginCancellation(error.error);
  }
  if (error instanceof Error && isRejectedString(error.message)) {
    return true;
  }

  const versioned = asRecord(error);
  if (isRejectedString(versioned.value)) {
    return true;
  }
  const domain = asRecord(versioned.value);
  if (domain.tag !== "Unknown") {
    return false;
  }
  const value = domain.value;
  return isRejectedString(value) || isRejectedString(asRecord(value).reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRejectedString(value: unknown): boolean {
  return value === "Rejected" || value === '"Rejected"';
}
