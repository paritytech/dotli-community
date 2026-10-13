// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product publishes one manifest per kind under `<kind>.<base>.<tld>`.

import type { ExecutableKind } from './manifest-types.js';

const EXECUTABLE_KINDS: readonly string[] = ['app', 'widget', 'worker'] satisfies readonly ExecutableKind[];

export function isExecutableKind(value: string): value is ExecutableKind {
  return EXECUTABLE_KINDS.includes(value);
}
