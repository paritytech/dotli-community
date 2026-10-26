// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const KIB = 1024;
const MIB = 1_048_576;

/** A byte count as people read it. Under a kilobyte it stays in bytes, so a few bytes never read as "0 kB". */
export function formatSize(bytes: number): string {
  if (bytes < KIB) {
    return `${String(Math.round(bytes))} B`;
  }
  return bytes < MIB ? `${String(Math.round(bytes / KIB))} kB` : `${(bytes / MIB).toFixed(1)} MB`;
}

/** A transfer rate, so a trickle reads in bytes rather than as "0 kB/s". */
export function formatRate(bytesPerSecond: number): string {
  return `${formatSize(bytesPerSecond)}/s`;
}
