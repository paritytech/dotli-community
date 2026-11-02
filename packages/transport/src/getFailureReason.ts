// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A reason crosses the wire and may end up in a metric label, so it stays short.
const MAX_REASON_CHARS = 500;

/** An error as `"<name>: <message>"`, bounded, so the peer keeps the error's name. */
export function getFailureReason(error: Error): string {
  return `${error.name}: ${error.message}`.slice(0, MAX_REASON_CHARS);
}

/**
 * A reason as `getFailureReason` wrote it, read back as the error's name and message. Text with no name is an
 * `Error`'s.
 */
export function parseReason(reason: string): { name: string; message: string } {
  const separator = reason.indexOf(': ');
  return separator < 0
    ? { name: 'Error', message: reason }
    : { name: reason.slice(0, separator), message: reason.slice(separator + 2) };
}
