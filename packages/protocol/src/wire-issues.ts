// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a transport cannot handle itself, reported as the protocol has always counted and logged it.

import { captureException, reportListener, spans as S, type m } from '@dotli/metrics';
import { errorName, log } from '@dotli/shared';
import type { TransportIssue } from '@dotli/transport';
import { callNameAt } from './call-names.js';

// A refused message's cause in the log, enough to tell decode failures apart.
const MAX_CAUSE_CHARS = 200;

type WireSide = 'host' | 'frame' | 'worker';

/** What the transport hands its owner, and data a provider dropped as no bytes, which only the owner hears. */
export type WireIssue = TransportIssue | { kind: 'refused'; reason: 'not_bytes' };

/**
 * Counts and logs each issue of the transport on `side`. A refused message is counted once with its reason, a post the
 * provider threw on is captured, logged and counted, and a listener that threw is reported as a listener.
 */
export function createIssueReporter(side: WireSide, count: typeof m.count): (issue: WireIssue) => void {
  const listenerThrew = reportListener('protocol', 'protocol.transport');
  return issue => {
    switch (issue.kind) {
      case 'refused': {
        const { reason } = issue;
        count(S.PROTOCOL_WIRE_REFUSED, { outcome: 'refused', reason, side });
        log.event('protocol message refused', {
          flow: 'protocol',
          reason,
          side,
          ...('cause' in issue
            ? { cause: `${issue.cause.name}: ${issue.cause.message}`.slice(0, MAX_CAUSE_CHARS) }
            : {}),
        });
        return;
      }
      case 'post_failed': {
        const { error, call } = issue;
        const method = call === undefined ? null : callNameAt(call.trait, call.method);
        captureException(error, {
          flow: 'protocol',
          step: 'serve_post',
          tags: method === null ? { side } : { method, side },
        });
        const what = method === null ? 'A message' : `A ${method} message`;
        log.error(`[dot.li protocol] ${what} could not be posted`, error);
        count(S.PROTOCOL_SERVE_POST, { outcome: 'error', reason: errorName(error) ?? 'unknown', side });
        return;
      }
      case 'listener_threw':
        listenerThrew(issue.error);
        return;
    }
  };
}
