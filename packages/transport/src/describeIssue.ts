// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getFailureReason } from './getFailureReason.js';

/**
 * What the transport cannot handle itself and hands to its owner. `refused` is a message it dropped, `post_failed` a
 * post the provider threw on, with the section and method names of the call it belonged to, if any, and
 * `listener_threw` a callback of the owner's that threw.
 */
export type TransportIssue =
  | { kind: 'refused'; reason: 'malformed' | 'invalid'; cause: Error }
  | { kind: 'post_failed'; error: Error; call?: { section: string; method: string } | undefined }
  | { kind: 'listener_threw'; error: Error };

/** An issue as one line of text, with the name of each error in it. */
export function describeIssue(issue: TransportIssue): string {
  switch (issue.kind) {
    case 'refused':
      return `A message was refused as ${issue.reason}, ${getFailureReason(issue.cause)}`;
    case 'post_failed':
      return issue.call === undefined
        ? `A message could not be posted, ${getFailureReason(issue.error)}`
        : `A ${issue.call.section}.${issue.call.method} message could not be posted, ${getFailureReason(issue.error)}`;
    case 'listener_threw':
      return `A listener threw, ${getFailureReason(issue.error)}`;
  }
}
