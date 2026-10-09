// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product publishes one manifest per kind under `<kind>.<base>.<tld>`.

export const EXECUTABLE_KINDS = ['app', 'widget', 'worker'] as const;

export type ExecutableKind = (typeof EXECUTABLE_KINDS)[number];

export function isExecutableKind(value: string): value is ExecutableKind {
  return (EXECUTABLE_KINDS as readonly string[]).includes(value);
}
