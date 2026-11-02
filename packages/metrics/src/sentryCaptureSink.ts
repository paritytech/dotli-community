// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import * as Sentry from '@sentry/browser';
import { serializeError } from '@dotli/shared';

import type { CaptureContext, CaptureSink } from './captureException.js';
import { getSentrySpan } from './createSpanHandle.js';
import { getNonErrorExtra } from './getNonErrorExtra.js';
import { toNonErrorThrow } from './toNonErrorThrow.js';

/** Sends captures to Sentry. Until the SDK is bound at startup, captures are dropped. */
export const sentryCaptureSink: CaptureSink = {
  exception: captureInSentry,
  expected: addExpectedBreadcrumb,
};

function captureInSentry(thrown: unknown, context: CaptureContext): void {
  const error = thrown instanceof Error ? thrown : toNonErrorThrow(thrown);
  const facts = getRemoteFacts(thrown);
  const tags: Record<string, string> = {
    ...context.tags,
    flow: context.flow,
    step: context.step,
    ...(facts.method !== undefined ? { protocol_method: facts.method } : {}),
  };
  const extra: Record<string, unknown> = {
    ...context.extra,
    ...(thrown instanceof Error ? {} : getNonErrorExtra(thrown)),
  };

  function capture(): void {
    Sentry.captureException(error, {
      tags,
      extra,
      fingerprint: ['{{ default }}', context.flow, context.step],
    });
  }

  const activeSpan = context.span === undefined ? undefined : getSentrySpan(context.span);
  if (activeSpan === undefined) {
    capture();
    return;
  }
  // The handle stores the SDK's own span object, typed opaque so the metrics API carries no SDK type.
  Sentry.withActiveSpan(activeSpan as Parameters<typeof Sentry.withActiveSpan>[0], capture);
}

function addExpectedBreadcrumb(thrown: unknown, context: Pick<CaptureContext, 'flow' | 'step'>): void {
  Sentry.addBreadcrumb({
    category: context.flow,
    level: 'warning',
    message: `${context.step}: ${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : serializeError(thrown)}`,
  });
}

/** Origin facts the protocol client attaches to errors it rebuilds from a failed protocol answer. */
function getRemoteFacts(thrown: unknown): { method?: string } {
  if (typeof thrown !== 'object' || thrown === null || !('method' in thrown)) {
    return {};
  }
  return typeof thrown.method === 'string' ? { method: thrown.method } : {};
}
