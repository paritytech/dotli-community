// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Canonical executable-manifest kinds. A product publishes one manifest per
// kind under an `<kind>.<base>.dot` subname. The host passes the base product
// name to the Rust core, so every executable kind shares one derived account.

export const EXECUTABLE_KINDS = ["app", "widget", "worker"] as const;

export type ExecutableKind = (typeof EXECUTABLE_KINDS)[number];

/** Runtime guard widening an arbitrary string to a known executable kind. */
export function isExecutableKind(value: string): value is ExecutableKind {
  return (EXECUTABLE_KINDS as readonly string[]).includes(value);
}
