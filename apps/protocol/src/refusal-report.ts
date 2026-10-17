// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the protocol iframe reports a call it refused or failed, for operators reading logs and the rejection counts.
// The host still hears each failure as the call's error.

import { spans as S, type m } from '@dotli/metrics';
import {
  isSharedAuthRequestMethod,
  isSharedModeRequestMethod,
  isSharedWalletRequestMethod,
  type RequestMethod,
  type ServingTransport,
  type SubscriptionMethod,
} from '@dotli/protocol';

export type FrameRoute = 'auth' | 'mode' | 'wallet' | 'chain';

export interface FrameRefusal {
  route: FrameRoute;
  method: string;
  error: unknown;
}

export interface RefusalReportDeps {
  warn: (...args: unknown[]) => void;
  count: typeof m.count;
}

/**
 * Reports wire bytes the frame's provider refused for their origin, before any call is read from them. Each one is
 * counted, and only the first from an origin is logged, so a hostile page that keeps posting cannot flood the log.
 */
export function createOriginRefusalReporter({ warn, count }: RefusalReportDeps): (origin: string) => void {
  const logged = new Set<string>();
  return origin => {
    count(S.PROTOCOL_WIRE_REFUSED, { outcome: 'refused', reason: 'origin', side: 'frame' });
    if (logged.has(origin)) {
      return;
    }
    logged.add(origin);
    warn(`[dot.li protocol] Rejected protocol messages from disallowed origin: ${origin}`);
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

function requestRoute(method: RequestMethod): FrameRoute {
  if (isSharedAuthRequestMethod(method)) {
    return 'auth';
  }
  if (isSharedModeRequestMethod(method)) {
    return 'mode';
  }
  if (isSharedWalletRequestMethod(method)) {
    return 'wallet';
  }
  return 'chain';
}

function subscriptionRoute(method: SubscriptionMethod): FrameRoute {
  return method === 'sharedAuthChanges' ? 'auth' : 'chain';
}

/** Serves on `serving` and tells `report` of each call a handler refuses or fails, before the host hears it. */
export function reportRefusals(serving: ServingTransport, report: (refusal: FrameRefusal) => void): ServingTransport {
  const refused = (route: FrameRoute, method: string, error: unknown): void => {
    report({ route, method, error });
  };

  return {
    handleRequest(method, handler) {
      const route = requestRoute(method);
      return serving.handleRequest(method, async (payload, context) => {
        try {
          return await handler(payload, context);
        } catch (error) {
          refused(route, method, error);
          throw error;
        }
      });
    },

    handleSubscription(method, handler) {
      const route = subscriptionRoute(method);
      return serving.handleSubscription(method, (payload, context, sink) => {
        const reporting: typeof sink = {
          send: event => {
            sink.send(event);
          },
          end: error => {
            if (error !== undefined) {
              refused(route, method, error);
            }
            sink.end(error);
          },
        };
        try {
          return handler(payload, context, reporting);
        } catch (error) {
          refused(route, method, error);
          throw error;
        }
      });
    },

    dispose(reason) {
      serving.dispose(reason);
    },
  };
}
