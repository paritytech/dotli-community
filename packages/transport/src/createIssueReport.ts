// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { toError } from '@dotli/shared';
import type { TransportIssue } from './describeIssue.js';
import { getFailureReason } from './getFailureReason.js';
import { logIssue } from './logIssue.js';

/** The owner's issue hook, as the transport's parts report to it. */
export type IssueReport = ReturnType<typeof createIssueReport>;

type Params = {
  /** Hears what the transport cannot handle itself. With none, each issue is logged as an error. */
  onIssue?: ((issue: TransportIssue) => void) | undefined;
};

/** The owner's issue hook, which never throws into the transport. */
export function createIssueReport({ onIssue }: Params) {
  function report(issue: TransportIssue): void {
    if (onIssue === undefined) {
      logIssue(issue);
      return;
    }
    try {
      onIssue(issue);
    } catch (error) {
      logIssue(issue);
      logIssue({
        kind: 'listener_threw',
        error: new Error(`The issue hook threw, ${getFailureReason(toError(error))}`, { cause: error }),
      });
    }
  }

  function refuse(reason: 'malformed' | 'invalid', cause: Error): void {
    report({ kind: 'refused', reason, cause });
  }

  function runListener(listener: () => void): void {
    try {
      listener();
    } catch (error) {
      report({ kind: 'listener_threw', error: toError(error) });
    }
  }

  return {
    /**
     * Hands `issue` to the owner's hook. Never throws: the hook must not throw into a provider's listener, so a throw
     * is logged with the issue it was handed.
     */
    report,
    /** Reports a message that does not decode, or does not fit what it names. Never throws. */
    refuse,
    /**
     * Runs a callback of the owner's. One that throws is reported as `listener_threw`, and the transport carries on.
     */
    runListener,
  };
}
