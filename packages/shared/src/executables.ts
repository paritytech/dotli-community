// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Canonical executable-manifest kinds. A product publishes one manifest per
// kind under an `<kind>.<base>.dot` subname, but all kinds share one derived
// account (see `stripExecutableSubname` in @dotli/auth/account). Single source
// of truth so the protocol bridge allowlist and the account derivation stay in
// sync.

export const EXECUTABLE_KINDS = ["app", "widget", "worker"] as const;

export type ExecutableKind = (typeof EXECUTABLE_KINDS)[number];

/** Runtime guard widening an arbitrary string to a known executable kind. */
export function isExecutableKind(value: string): value is ExecutableKind {
  return (EXECUTABLE_KINDS as readonly string[]).includes(value);
}
