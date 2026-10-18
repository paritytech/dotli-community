// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a transport cannot handle itself, reported as the protocol has always counted and logged it.

import { captureException, reportListener, spans as S, type m } from '@dotli/metrics';
import { errorName, log, toError } from '@dotli/shared';
import type { TransportIssue } from '@dotli/transport';

// A refused message's cause in the log, enough to tell decode failures apart.
const MAX_CAUSE_CHARS = 200;

type WireSide = 'host' | 'frame' | 'worker';

/**
 * Counts and logs each issue of the transport on `side`. A refused message is counted once with its reason, a post the
 * provider threw on is captured, logged and counted, and a listener that threw is reported as a listener.
 */
export function createIssueReporter(side: WireSide, count: typeof m.count): (issue: TransportIssue) => void {
  const listenerThrew = reportListener('protocol', 'protocol.transport');
  return issue => {
    switch (issue.kind) {
      case 'refused': {
        const { reason, cause } = issue;
        count(S.PROTOCOL_WIRE_REFUSED, { outcome: 'refused', reason, side });
        const failure = cause === undefined ? null : toError(cause);
        log.event('protocol message refused', {
          flow: 'protocol',
          reason,
          side,
          ...(failure === null ? {} : { cause: `${failure.name}: ${failure.message}`.slice(0, MAX_CAUSE_CHARS) }),
        });
        return;
      }
      case 'post_failed': {
        const { error } = issue;
        captureException(error, { flow: 'protocol', step: 'serve_post', tags: { side } });
        log.error('[dot.li protocol] A message could not be posted', error);
        count(S.PROTOCOL_SERVE_POST, { outcome: 'error', reason: errorName(error) ?? 'unknown', side });
        return;
      }
      case 'listener_threw':
        listenerThrew(issue.error);
        return;
    }
  };
}
