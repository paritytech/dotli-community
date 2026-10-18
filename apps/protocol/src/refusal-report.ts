// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the protocol iframe and the SharedWorker report what they refuse, for operators reading logs and the rejection
// counts: messages their transport or provider drops, and calls their handlers refuse or fail. The host still hears
// each call's failure as the call's answer.

import { spans as S, type m } from '@dotli/metrics';
import {
  callName,
  createIssueReporter,
  failureOf,
  isSharedModeRequestMethod,
  type CallName,
  type ProtocolSchema,
  type ProtocolTransport,
} from '@dotli/protocol';
import type { CallError, DomainError, Result, TraitName, TransportIssue } from '@dotli/transport';

export type FrameRoute = 'auth' | 'mode' | 'wallet' | 'chain';

export interface FrameRefusal {
  route: FrameRoute;
  /** The call by the name the metrics and the trail know it by. */
  method: CallName;
  /** What the handler threw, or the failure it answered with as the error host code sees. */
  error: unknown;
}

export interface RefusalReportDeps {
  warn: (...args: unknown[]) => void;
  count: typeof m.count;
}

/** Where a side reports what its transport and its window provider drop. */
export interface WireReport {
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
export function createWireReport(side: 'frame' | 'worker', { warn, count }: RefusalReportDeps): WireReport {
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

export function createRefusalReporter({ warn, count }: RefusalReportDeps): (refusal: FrameRefusal) => void {
  return refusal => {
    const { route } = refusal;
    if (route === 'auth' || route === 'mode') {
      count(S.SHARED_STORAGE_REJECTED, { store: route, reason: 'validation' });
      return;
    }
    // The host rebuilds this failure from the answer and reports it.
    warn(`[dot.li protocol] ${refusal.method} failed`, refusal.error);
  };
}

function routeOf(trait: TraitName<ProtocolSchema>, method: string): FrameRoute {
  switch (trait) {
    case 'storage':
      return isSharedModeRequestMethod(method) ? 'mode' : 'auth';
    case 'wallet':
      return 'wallet';
    case 'frame':
    case 'resolve':
    case 'chain':
      return 'chain';
  }
}

/**
 * Serves on `serving` and tells `report` of each call a handler refuses or fails, before the host hears it: a handler
 * that throws or rejects, one that answers with a failure, and a subscription that ends with one.
 */
export function reportRefusals(serving: ProtocolTransport, report: (refusal: FrameRefusal) => void): ProtocolTransport {
  return {
    ...serving,

    handleRequest(trait, method, handler) {
      const refusal = (error: unknown): FrameRefusal => ({
        route: routeOf(trait, method),
        method: callName(trait, method),
        error,
      });
      return serving.handleRequest(trait, method, async (payload, context) => {
        try {
          const answer = await handler(payload, context);
          // Every answer is a `Result`, which the method's deferred answer type does not show here.
          const outcome = answer as Result<
            unknown,
            CallError<DomainError<ProtocolSchema, typeof trait, typeof method>>
          >;
          if (!outcome.ok) {
            report(refusal(failureOf(trait, method, outcome.error)));
          }
          return answer;
        } catch (error) {
          report(refusal(error));
          throw error;
        }
      });
    },

    handleSubscription(trait, method, handler) {
      const refusal = (error: unknown): FrameRefusal => ({
        route: routeOf(trait, method),
        method: callName(trait, method),
        error,
      });
      return serving.handleSubscription(trait, method, (start, context, sink) => {
        const reporting: typeof sink = {
          receive: value => {
            sink.receive(value);
          },
          interrupt: error => {
            if (error !== undefined) {
              report(refusal(failureOf(trait, method, error)));
            }
            sink.interrupt(error);
          },
        };
        try {
          return handler(start, context, reporting);
        } catch (error) {
          report(refusal(error));
          throw error;
        }
      });
    },
  };
}
