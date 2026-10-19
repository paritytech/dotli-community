// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Enum, Struct, _void, str, type Codec, type CodecType, type ResultPayload } from 'scale-ts';
import { log } from '@dotli/shared';

/** The opener heard no answer to its handshake within the timeout, counted on the running clock. */
export class TransportHandshakeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportHandshakeTimeoutError';
  }
}

/** The peer speaks another schema version, so no call can cross. A reload, not a retry, fixes it. */
export class TransportUnsupportedProtocolVersionError extends Error {
  constructor(ours: number, theirs: number) {
    super(`The peer speaks version ${String(theirs)} and this side ${String(ours)}`);
    this.name = 'TransportUnsupportedProtocolVersionError';
  }
}

/**
 * What the transport cannot handle itself and hands to its owner. `refused` is a message it dropped, `post_failed` a
 * post the provider threw on, with the section and method names of the call it belonged to, if any, and `listener_threw`
 * a callback of the owner's that threw.
 */
export type TransportIssue =
  | { kind: 'refused'; reason: 'malformed' | 'invalid'; cause: Error }
  | { kind: 'post_failed'; error: Error; call?: { section: string; method: string } | undefined }
  | { kind: 'listener_threw'; error: Error };

// A reason crosses the wire and may end up in a metric label, so it stays short.
const MAX_REASON_CHARS = 500;
// One log line per issue, enough to tell issues apart.
const MAX_LOG_CHARS = 200;

/** An error as `"<name>: <message>"`, bounded, so the peer keeps the error's name. */
export function failureReason(error: Error): string {
  return `${error.name}: ${error.message}`.slice(0, MAX_REASON_CHARS);
}

/** A reason as `failureReason` wrote it, read back as the error's name and message. Text with no name is an `Error`'s. */
export function reasonParts(reason: string): { name: string; message: string } {
  const at = reason.indexOf(': ');
  return at < 0 ? { name: 'Error', message: reason } : { name: reason.slice(0, at), message: reason.slice(at + 2) };
}

/** An issue as one line of text, with the name of each error in it. */
export function describeIssue(issue: TransportIssue): string {
  switch (issue.kind) {
    case 'refused':
      return `A message was refused as ${issue.reason}, ${failureReason(issue.cause)}`;
    case 'post_failed':
      return issue.call === undefined
        ? `A message could not be posted, ${failureReason(issue.error)}`
        : `A ${issue.call.section}.${issue.call.method} message could not be posted, ${failureReason(issue.error)}`;
    case 'listener_threw':
      return `A listener threw, ${failureReason(issue.error)}`;
  }
}

/** The issue hook of a transport whose owner sets none. */
export function logIssue(issue: TransportIssue): void {
  log.error(`[transport] ${describeIssue(issue)}`.slice(0, MAX_LOG_CHARS));
}

// truapi's `Result` and `CallError`. A `Result` is scale-ts's own. A `CallError` is the method's own `Domain` error or a
// failure of the library's, and the library's failures are an enum of their own, so the library answers any call with
// one whatever the method's error is.

/** Wraps a value as a success. Called with no argument it is the success of a call that returns nothing. */
export function ok(): ResultPayload<undefined, never>;
export function ok<T>(value: T): ResultPayload<T, never>;
export function ok<T>(value?: T): ResultPayload<T | undefined, never> {
  return { success: true, value };
}

/** Wraps an error as a failure. */
export function err<E>(error: E): ResultPayload<never, E> {
  return { success: false, value: error };
}

const failures = {
  Denied: _void,
  Unsupported: _void,
  MalformedFrame: Struct({ reason: str }),
  HostFailure: Struct({ reason: str }),
  Cancelled: _void,
};

/** A failure of the library's own. `Cancelled` is raised by the caller's own side when it aborts. */
export const failure = Enum(failures);

export type Failure = CodecType<typeof failure>;

/** Why a call did not return its value: the method's own `Domain` error, or a failure of the library's. */
export type CallError<E> = { tag: 'Domain'; value: E } | Failure;

/** truapi's `CallError`, with `Domain` first. A request's answer carries one, as does an interrupt that chooses it. */
export const callError = <E>(domain: Codec<E>): Codec<CallError<E>> => Enum({ Domain: domain, ...failures });

export const domain = <E>(value: E): CallError<E> => ({ tag: 'Domain', value });
export const denied = (): Failure => ({ tag: 'Denied', value: undefined });
export const unsupported = (): Failure => ({ tag: 'Unsupported', value: undefined });
/**
 * A failure's reason. Given an `Error`, it is `"<name>: <message>"`, bounded. truapi's failures have one reason and no
 * name, so the name rides in it.
 */
const reasonOf = (why: string | Error): { reason: string } => ({
  reason: typeof why === 'string' ? why : failureReason(why),
});

/** A message that did not decode, or did not fit what it names. */
export const malformedFrame = (why: string | Error): Failure => ({ tag: 'MalformedFrame', value: reasonOf(why) });
/** A handler's failure. Given an `Error`, the reason is the one a handler that throws it answers with. */
export const hostFailure = (why: string | Error): Failure => ({ tag: 'HostFailure', value: reasonOf(why) });
export const cancelled = (): Failure => ({ tag: 'Cancelled', value: undefined });
