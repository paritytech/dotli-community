// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a transport and its window provider cannot handle themselves, reported as the protocol has always counted and
// logged it.

import { captureException, reportListener, spans as S, type m } from '@dotli/metrics';
import { errorName, log } from '@dotli/shared';
import { failureReason, type TransportIssue } from '@dotli/transport';
import { callNameAt } from './method-policy.js';

// A refused message's cause in the log, enough to tell decode failures apart.
const MAX_CAUSE_CHARS = 200;

type WireSide = 'host' | 'frame' | 'worker';

/** What the transport hands its owner, and data a provider dropped as no bytes, which only the owner hears. */
type WireIssue = TransportIssue | { kind: 'refused'; reason: 'not_bytes' };

/**
 * Counts and logs each issue of the transport on `side`. A refused message is counted once with its reason, a post the
 * provider threw on is captured, logged and counted, and a listener that threw is reported as a listener.
 */
function createIssueReporter(side: WireSide, count: typeof m.count): (issue: WireIssue) => void {
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
          ...('cause' in issue ? { cause: failureReason(issue.cause).slice(0, MAX_CAUSE_CHARS) } : {}),
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

interface WireReportDeps {
  count: typeof m.count;
  /** Where a refused origin is logged. The shared log when unset. */
  warn?: (...args: unknown[]) => void;
}

/** Where a side reports what its transport and its window provider drop. */
interface WireReport {
  /** The transport's issue hook. */
  onIssue: (issue: TransportIssue) => void;
  /** Data from the admitted peer that is not bytes, which the provider drops before the transport sees it. */
  onNotBytes: () => void;
  /** Bytes from a page at an origin the provider does not admit. */
  onRefusedOrigin: (origin: string) => void;
}

/**
 * Reports what the transport and the window provider of `side` drop, each once. A refused message, a post the provider
 * threw on and a listener that threw are reported as every side of the protocol reports them. Only the first bytes from
 * a refused origin are counted and logged, so the metric reads as "this origin tried the wire" and a hostile page that
 * keeps posting floods neither the log nor the metrics.
 */
export function createWireReport(side: WireSide, { count, warn = log.warn }: WireReportDeps): WireReport {
  const onIssue = createIssueReporter(side, count);
  const refusedOrigins = new Set<string>();
  return {
    onIssue,
    onNotBytes: () => {
      onIssue({ kind: 'refused', reason: 'not_bytes' });
    },
    onRefusedOrigin: origin => {
      if (refusedOrigins.has(origin)) {
        return;
      }
      refusedOrigins.add(origin);
      count(S.PROTOCOL_WIRE_REFUSED, { outcome: 'refused', reason: 'origin', side });
      warn(`[dot.li protocol] Rejected protocol messages from disallowed origin: ${origin}`);
    },
  };
}
