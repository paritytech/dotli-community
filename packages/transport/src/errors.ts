// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { errorMessage, log, toError } from '@dotli/shared';

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
  | { kind: 'refused'; reason: 'malformed' | 'invalid' | 'not_bytes'; cause?: unknown }
  | { kind: 'post_failed'; error: unknown; call?: { trait: string; method: string } }
  | { kind: 'listener_threw'; error: unknown };

// A reason crosses the wire and may end up in a metric label, so it stays short.
const MAX_REASON_CHARS = 500;
// One log line per issue, enough to tell issues apart.
const MAX_LOG_CHARS = 200;

/** A thrown value as `"<name>: <message>"`, bounded, so the peer keeps the error's name. */
export function failureReason(error: unknown): string {
  const failure = toError(error);
  return `${failure.name}: ${failure.message}`.slice(0, MAX_REASON_CHARS);
}

/** Why a payload did not decode, bounded. */
export function decodeReason(cause: unknown): string {
  return errorMessage(cause).slice(0, MAX_REASON_CHARS);
}

function describeIssue(issue: TransportIssue): string {
  switch (issue.kind) {
    case 'refused':
      return issue.cause === undefined
        ? `A message was refused as ${issue.reason}`
        : `A message was refused as ${issue.reason}, ${failureReason(issue.cause)}`;
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
