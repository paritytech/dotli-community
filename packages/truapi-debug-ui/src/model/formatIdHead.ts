// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A value longer than 10 shown as its first 8 characters and an ellipsis, any shorter value unchanged. Never throws. */
export function formatIdHead(id: string): string {
  if (id.length > 10) {
    return `${id.slice(0, 8)}…`;
  }
  return id;
}
