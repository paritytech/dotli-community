// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a transport and its window provider cannot handle themselves, reported as the protocol has always counted and
// logged it.

import { createReporter, defineCount, type CountSink } from '@dotli/metrics';
import { getErrorName, log } from '@dotli/shared';
import { getFailureReason, type TransportIssue } from '@dotli/transport';
import { getCallNameAt } from './methodPolicy.js';

const report = createReporter({ flow: 'protocol' });

/**
 * A protocol message dropped on receipt. Tagged `outcome` (refused), `side` (host, frame or worker) and `reason`:
 * `malformed` for bytes that are no message, `invalid` for a message whose values its method refuses, `not_bytes` for
 * data that is not an `ArrayBuffer`, which a host page of an earlier release sends, and `origin` for the first bytes
 * from each page outside the frame's trust boundary.
 */
const protocolWireRefusedMetric = defineCount<'refused'>('protocol.wire_refused');

/**
 * A protocol message a side could not post, so its peer never hears it. Tagged `outcome` (error), `side` (host, frame
 * or worker) and `reason` (the error's name).
 */
const protocolServePostMetric = defineCount<'error'>('protocol.serve_post');

type WireSide = 'host' | 'frame' | 'worker';

/** What the transport hands its owner, and data a provider dropped as no bytes, which only the owner hears. */
type WireIssue = TransportIssue | { kind: 'refused'; reason: 'not_bytes' };

type Params = {
  /** The side whose wire this reports, which tags every count. */
  side: WireSide;
  count: CountSink;
  /** Where a refused origin is logged. The shared log when unset. */
  warn?: (...args: unknown[]) => void;
};

type IssueReporterParams = Pick<Params, 'side' | 'count'>;

// A refused message's cause in the log, enough to tell decode failures apart.
const MAX_CAUSE_CHARS = 200;

/**
 * Reports what the transport and the window provider of `side` drop, each once. A refused message, a post the provider
 * threw on and a listener that threw are reported as every side of the protocol reports them. Only the first bytes from
 * a refused origin are counted and logged, so the metric reads as "this origin tried the wire" and a hostile page that
 * keeps posting floods neither the log nor the metrics.
 *
 * @example
 * // wire.onIssue goes to the transport, the rest to the window provider
 * const wire = createWireReport({ side: 'frame', count: countMetric });
 */
export function createWireReport({ side, count, warn = log.warn }: Params) {
  const reportIssue = createIssueReporter({ side, count });
  const refusedOrigins = new Set<string>();

  function reportNotBytes(): void {
    reportIssue({ kind: 'refused', reason: 'not_bytes' });
  }

  function reportRefusedOrigin(origin: string): void {
    if (refusedOrigins.has(origin)) {
      return;
    }
    refusedOrigins.add(origin);
    count(protocolWireRefusedMetric, { outcome: 'refused', reason: 'origin', side });
    warn(`[dot.li protocol] Rejected protocol messages from disallowed origin: ${origin}`);
  }

  return {
    /** The transport's issue hook, which counts and logs each issue. */
    onIssue: reportIssue,
    /** Data from the admitted peer that is not bytes, which the provider drops before the transport sees it. */
    onNotBytes: reportNotBytes,
    /** Bytes from a page at an origin the provider does not admit. Only the first bytes of each origin are reported. */
    onRefusedOrigin: reportRefusedOrigin,
  };
}

/**
 * Counts and logs each issue of the transport on `side`. A refused message is counted once with its reason, a post the
 * provider threw on is captured, logged and counted, and a listener that threw is reported as a listener.
 */
function createIssueReporter({ side, count }: IssueReporterParams): (issue: WireIssue) => void {
  const reportListenerError = report.listener('protocol.transport');

  function reportIssue(issue: WireIssue): void {
    switch (issue.kind) {
      case 'refused': {
        const { reason } = issue;
        count(protocolWireRefusedMetric, { outcome: 'refused', reason, side });
        report.log.event('protocol message refused', {
          reason,
          side,
          ...('cause' in issue ? { cause: getFailureReason(issue.cause).slice(0, MAX_CAUSE_CHARS) } : {}),
        });
        return;
      }
      case 'post_failed': {
        const { error, call } = issue;
        const method = call === undefined ? null : getCallNameAt(call.section, call.method);
        // Captured, logged and counted by hand, since the count is the injected one.
        report.capture(error, {
          step: 'serve_post',
          tags: method === null ? { side } : { method, side },
        });
        const what = method === null ? 'A message' : `A ${method} message`;
        log.error(`[dot.li protocol] ${what} could not be posted`, error);
        count(protocolServePostMetric, { outcome: 'error', reason: getErrorName(error) ?? 'unknown', side });
        return;
      }
      case 'listener_threw':
        reportListenerError(issue.error);
        return;
    }
  }

  return reportIssue;
}
