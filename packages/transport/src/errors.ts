// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { log } from '@dotli/shared';

/** The opener heard no answer to its handshake within the timeout, counted on the running clock. */
export class TransportHandshakeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportHandshakeTimeoutError';
  }
}

/** The peer speaks another schema version, so no call can cross. A reload, not a retry, fixes it. */
export class TransportVersionMismatchError extends Error {
  readonly ours: number;
  readonly theirs: number;

  constructor(ours: number, theirs: number) {
    super(`The peer speaks version ${String(theirs)} and this side ${String(ours)}`);
    this.name = 'TransportVersionMismatchError';
    this.ours = ours;
    this.theirs = theirs;
  }
}

/**
 * What the transport cannot handle itself and hands to its owner. `refused` is a message it dropped, `post_failed` a
 * post the provider threw on, with the trait and method names of the call it belonged to, if any, and `listener_threw`
 * a callback of the owner's that threw.
 */
export type TransportIssue =
  | { kind: 'refused'; reason: 'malformed' | 'invalid'; cause: Error }
  | { kind: 'post_failed'; error: Error; call?: { trait: string; method: string } | undefined }
  | { kind: 'listener_threw'; error: Error };

// A reason crosses the wire and may end up in a metric label, so it stays short.
const MAX_REASON_CHARS = 500;
// One log line per issue, enough to tell issues apart.
const MAX_LOG_CHARS = 200;

/** An error as `"<name>: <message>"`, bounded, so the peer keeps the error's name. */
export function failureReason(error: Error): string {
  return `${error.name}: ${error.message}`.slice(0, MAX_REASON_CHARS);
}

function describeIssue(issue: TransportIssue): string {
  switch (issue.kind) {
    case 'refused':
      return `A message was refused as ${issue.reason}, ${failureReason(issue.cause)}`;
    case 'post_failed':
      return issue.call === undefined
        ? `A message could not be posted, ${failureReason(issue.error)}`
        : `A ${issue.call.trait}.${issue.call.method} message could not be posted, ${failureReason(issue.error)}`;
    case 'listener_threw':
      return `A listener threw, ${failureReason(issue.error)}`;
  }
}

/** The issue hook of a transport whose owner sets none. */
export function logIssue(issue: TransportIssue): void {
  log.error(`[transport] ${describeIssue(issue)}`.slice(0, MAX_LOG_CHARS));
}
