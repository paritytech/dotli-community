// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SentrySpan, SpanValue } from './types.js';

/** A span that outlives its call, for work that opens and closes on separate messages. */
export type SpanHandle = {
  /** Sets attributes on the span. Ignored after `end`. */
  setAttributes: (attributes: Record<string, SpanValue>) => void;
  /** Opens a span nested under this one, closed later by its own `end`. Inert when this handle is. */
  child: (name: string, options?: OpenSpanParams) => SpanHandle;
  /** Ends the span. Repeat calls are ignored, so a failure path can end a span the success path already ended. */
  end: (endTime?: number) => void;
};

export type OpenSpanParams = {
  /** Epoch milliseconds, defaults to now. */
  startTime?: number;
  /** Attributes set on the span when it opens. */
  attributes?: Record<string, SpanValue>;
  /** Present the span as its own transaction in Sentry rather than a nested row. */
  root?: boolean;
};

type Params = {
  /** The started SDK span the handle drives. */
  sentrySpan: SentrySpan;
  /** Opens a span under `sentrySpan`. */
  openChild: (name: string, options?: OpenSpanParams) => SpanHandle;
};

/** The handle of a span that was never started, which records nothing. */
export const INERT_SPAN_HANDLE: SpanHandle = {
  setAttributes: () => {
    /* no span to attribute */
  },
  child: () => INERT_SPAN_HANDLE,
  end: () => {
    /* no span to end */
  },
};

// The handle keeps the SDK span so a capture can join its trace. Weak, so the span dies with its handle.
const sentrySpans = new WeakMap<SpanHandle, SentrySpan>();

/** Hand out a started Sentry span as a handle, which ignores calls after its first `end`. */
export function createSpanHandle({ sentrySpan, openChild }: Params): SpanHandle {
  let ended = false;

  function setAttributes(attributes: Record<string, SpanValue>): void {
    if (ended) {
      return;
    }
    sentrySpan.setAttributes(attributes);
  }

  function end(endTime?: number): void {
    if (ended) {
      return;
    }
    ended = true;
    sentrySpan.end(endTime);
  }

  const handle: SpanHandle = { setAttributes, child: openChild, end };
  sentrySpans.set(handle, sentrySpan);
  return handle;
}

/** Package-private. The SDK's span behind a handle, undefined for an inert handle. */
export function getSentrySpan(handle: SpanHandle): unknown {
  return sentrySpans.get(handle);
}
