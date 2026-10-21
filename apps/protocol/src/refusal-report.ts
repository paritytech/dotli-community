// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the protocol iframe and the SharedWorker report the calls their handlers refuse or fail, for operators reading
// logs and the rejection counts. The host still hears each call's failure as the call's answer.

import { spans as S, type m } from '@dotli/metrics';
import {
  callName,
  type CallName,
  failureOf,
  isSharedModeRequestMethod,
  protocolSchema,
  type ProtocolServing,
} from '@dotli/protocol';
import { toError } from '@dotli/shared';
import type { AnyMethod } from '@dotli/transport';

export type FrameRoute = 'auth' | 'mode' | 'wallet' | 'chain';

export interface FrameRefusal {
  route: FrameRoute;
  /** The call by the name the metrics and the trail know it by. */
  method: CallName;
  /** What the handler threw, or the failure it answered with as the error host code sees. */
  error: Error;
}

export interface RefusalReportDeps {
  warn: (...args: unknown[]) => void;
  count: typeof m.count;
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

function routeOf(method: AnyMethod): FrameRoute {
  const address = protocolSchema.addressOf(method);
  if (address.section === 'storage') {
    return isSharedModeRequestMethod(address.method) ? 'mode' : 'auth';
  }
  return address.section === 'wallet' ? 'wallet' : 'chain';
}

/**
 * Serves on `serving` and tells `report` of each call a handler refuses or fails, before the host hears it: a handler
 * that throws or rejects, one that answers with a failure, and a subscription that ends with one.
 */
export function reportRefusals(serving: ProtocolServing, report: (refusal: FrameRefusal) => void): ProtocolServing {
  const refused = (method: AnyMethod, error: Error): void => {
    report({ route: routeOf(method), method: callName(method), error });
  };
  return {
    handleRequest(method, handler) {
      return serving.handleRequest(method, async (payload, context) => {
        try {
          const answer = await handler(payload, context);
          if (!answer.success) {
            refused(method, failureOf(method, answer.value));
          }
          return answer;
        } catch (error) {
          refused(method, toError(error));
          throw error;
        }
      });
    },

    handleSubscription(method, handler) {
      return serving.handleSubscription(method, (start, context, sink) => {
        const reporting: typeof sink = {
          ...sink,
          interrupt: outcome => {
            if (!outcome.success) {
              refused(method, failureOf(method, outcome.value));
            }
            sink.interrupt(outcome);
          },
        };
        try {
          return handler(start, context, reporting);
        } catch (error) {
          refused(method, toError(error));
          throw error;
        }
      });
    },
  };
}
