// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The export's file name, stamped with `now` to the second in UTC. Never throws for a valid date. */
export function formatExportFilename(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
  return `dotli-debug-${stamp}.json`;
}
