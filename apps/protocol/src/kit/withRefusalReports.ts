// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Tells a report of each call the protocol iframe's or the SharedWorker's handlers refuse or fail, for operators
// reading logs and the rejection counts. The host still hears each call's failure as the call's answer.

import {
  getCallName,
  type CallName,
  getFailure,
  isSharedModeRequestMethod,
  protocolSchema,
  type ProtocolSchema,
  type ProtocolServing,
} from '@dotli/protocol';
import { toError } from '@dotli/shared';
import type { AnyMethod } from '@dotli/transport';

type ProtocolSection = keyof ProtocolSchema['sections'];

export type FrameRoute = 'auth' | 'mode' | 'wallet' | 'chain';

export type FrameRefusal = {
  route: FrameRoute;
  /** The call by the name the metrics and the trail know it by. */
  method: CallName;
  /** What the handler threw, or the failure it answered with as the error host code sees. */
  error: Error;
};

/**
 * Serves on `serving` and tells `report` of each call a handler refuses or fails, before the host hears it: a handler
 * that throws or rejects, one that answers with a failure, and a subscription that ends with one.
 */
export function withRefusalReports(serving: ProtocolServing, report: (refusal: FrameRefusal) => void): ProtocolServing {
  return {
    handleRequest(method, handler) {
      return serving.handleRequest(method, async (payload, context) => {
        try {
          const answer = await handler(payload, context);
          if (!answer.success) {
            reportRefused(method, getFailure(method, answer.value));
          }
          return answer;
        } catch (error) {
          reportRefused(method, toError(error));
          throw error;
        }
      });
    },

    handleSubscription(method, handler) {
      return serving.handleSubscription(method, (start, context, sink) => {
        const reporting: typeof sink = {
          ...sink,
          interrupt(outcome) {
            if (!outcome.success) {
              reportRefused(method, getFailure(method, outcome.value));
            }
            sink.interrupt(outcome);
          },
        };
        try {
          return handler(start, context, reporting);
        } catch (error) {
          reportRefused(method, toError(error));
          throw error;
        }
      });
    },
  };

  function reportRefused(method: AnyMethod, error: Error): void {
    report({ route: getRoute(method), method: getCallName(method), error });
  }
}

function getRoute(method: AnyMethod): FrameRoute {
  const address = protocolSchema.addressOf(method);
  const section = requireSection(address.section);
  switch (section) {
    case 'storage':
      return isSharedModeRequestMethod(address.method) ? 'mode' : 'auth';
    case 'wallet':
      return 'wallet';
    case 'frame':
    case 'resolve':
    case 'chain':
      return 'chain';
  }
}

/** The protocol section named `section`. Throws for a name the protocol lacks. */
function requireSection(section: string): ProtocolSection {
  if (!isProtocolSection(section)) {
    throw new Error(`The section '${section}' is not one of the protocol's`);
  }
  return section;
}

function isProtocolSection(section: string): section is ProtocolSection {
  return Object.hasOwn(protocolSchema.sections, section);
}
