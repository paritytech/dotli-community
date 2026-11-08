// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The SharedWorker's span of one tab's request, labelled with the page load that tab's hello names.

import type { m, SpanHandle } from '@dotli/metrics';
import {
  getCallName,
  getFailure,
  getPolicy,
  type CallName,
  type DomainFailure,
  type ProtocolContext,
  type ProtocolHello,
  type SubscriptionEnd,
} from '@dotli/protocol';
import { getErrorName, toError } from '@dotli/shared';
import type {
  CallError,
  Request,
  RequestHandler,
  ResultPayload,
  Sink,
  Subscription,
  SubscriptionHandler,
} from '@dotli/transport';

/**
 * One request as the SharedWorker served it, tagged with the asking tab's `resolution_id`. Apart from
 * `protocol.request` because it excludes the postMessage hops.
 */
const PROTOCOL_WORKER_REQUEST = 'protocol.worker_request';

type WithRequestSpanParams<Payload, Response, Domain extends DomainFailure> = {
  /** Opens the span of each timed call. */
  openSpan: typeof m.open;
  /** The method served, whose policy says whether its calls are timed. */
  method: Request<Payload, Response, Domain>;
  /** Answers each call. Its answer or throw is passed on as it is. */
  handler: RequestHandler<NoInfer<Payload>, NoInfer<Response>, NoInfer<Domain>, ProtocolHello>;
};

type WithSubscriptionSpanParams<Start, Value, Domain extends DomainFailure> = {
  /** Opens the span of each subscription. */
  openSpan: typeof m.open;
  /** The method served. */
  method: Subscription<Start, Value, SubscriptionEnd<Domain>>;
  /** Whether a value answers the subscription, which ends its span. */
  isAnswer: (value: NoInfer<Value>) => boolean;
  /** Serves each subscription. Its values, end and throw are passed on as they are. */
  handler: SubscriptionHandler<NoInfer<Start>, NoInfer<Value>, NoInfer<SubscriptionEnd<Domain>>, ProtocolHello>;
};

type OpenRequestSpanParams = {
  /** Opens the span. */
  openSpan: typeof m.open;
  /** The call's name, as the span's `method` attribute. */
  method: CallName;
  /** The tab's page load, kept only when it is shaped like an id. */
  resolutionId: string | null;
};

// Bounds what a tab can write into this worker's span attributes, and admits a UUID.
const RESOLUTION_ID_PATTERN = /^[\w-]{1,64}$/;

/**
 * Spans a request when its calls are timed, and returns `handler` itself when they are not. Throws when `method` is not
 * one of the protocol.
 */
export function withRequestSpan<Payload, Response, Domain extends DomainFailure>({
  openSpan,
  method,
  handler,
}: WithRequestSpanParams<Payload, Response, Domain>): RequestHandler<Payload, Response, Domain, ProtocolHello> {
  const { name, timed } = getPolicy(method);
  if (!timed) {
    return handler;
  }
  return answerSpanned;

  async function answerSpanned(
    payload: Payload,
    context: ProtocolContext,
  ): Promise<ResultPayload<Response, CallError<Domain>>> {
    const span = openRequestSpan({ openSpan, method: name, resolutionId: context.hello.resolutionId });
    try {
      const answer = await handler(payload, context);
      endSpan(span, answer.success ? undefined : getFailure(method, answer.value));
      return answer;
    } catch (error) {
      endSpan(span, toError(error));
      throw error;
    }
  }
}

/**
 * Spans a subscription until the value that answers it, or its end, or the tab stopping it first. Throws when `method`
 * is not one of the protocol.
 */
export function withSubscriptionSpan<Start, Value, Domain extends DomainFailure>({
  openSpan,
  method,
  isAnswer,
  handler,
}: WithSubscriptionSpanParams<Start, Value, Domain>): SubscriptionHandler<
  Start,
  Value,
  SubscriptionEnd<Domain>,
  ProtocolHello
> {
  const name = getCallName(method);
  return startSpanned;

  function startSpanned(
    start: Start,
    context: ProtocolContext,
    sink: Sink<Value, SubscriptionEnd<Domain>>,
  ): () => void {
    const span = openRequestSpan({ openSpan, method: name, resolutionId: context.hello.resolutionId });
    let open = true;
    const spanned: Sink<Value, SubscriptionEnd<Domain>> = {
      send(value) {
        sink.send(value);
        if (isAnswer(value)) {
          settle(undefined);
        }
      },
      interrupt(outcome) {
        settle(outcome.success ? undefined : getFailure(method, outcome.value));
        sink.interrupt(outcome);
      },
    };
    let stop: () => void;
    try {
      stop = handler(start, context, spanned);
    } catch (error) {
      settle(toError(error));
      throw error;
    }
    return stopSpanned;

    function settle(error: Error | undefined | 'cancelled'): void {
      if (!open) {
        return;
      }
      open = false;
      endSpan(span, error);
    }

    function stopSpanned(): void {
      settle('cancelled');
      stop();
    }
  }
}

/** The resolution id goes on this span alone, since scope or metric defaults would label other tabs' work too. */
function openRequestSpan({ openSpan, method, resolutionId }: OpenRequestSpanParams): SpanHandle {
  return openSpan(PROTOCOL_WORKER_REQUEST, {
    root: true,
    attributes: {
      method,
      ...(resolutionId !== null && RESOLUTION_ID_PATTERN.test(resolutionId) ? { resolution_id: resolutionId } : {}),
    },
  });
}

/** Ends `span` as answered, failed with `error`, or cancelled by the tab. */
function endSpan(span: SpanHandle, error: Error | undefined | 'cancelled'): void {
  if (error === undefined || error === 'cancelled') {
    span.setAttributes({ outcome: error ?? 'ok' });
  } else {
    span.setAttributes({ outcome: 'error', error_name: getErrorName(error) ?? 'NonError' });
  }
  span.end();
}
