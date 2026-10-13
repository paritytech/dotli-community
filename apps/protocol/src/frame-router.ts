// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol iframe's one window listener. Each request from an allowed host page goes to the store or engine that
// serves its method, and a handler's failure is answered as an error response.

import {
  isProtocolEnvelope,
  isSharedAuthRequestMethod,
  isSharedModeRequestMethod,
  isSharedWalletRequestMethod,
  type ProtocolEnvelope,
  type ProtocolRequestEnvelope,
} from '@dotli/protocol';

import type { ResponseCallback } from './engine.js';
import { errorResponse } from './error-response.js';

export type FrameRoute = 'auth' | 'mode' | 'wallet' | 'chain';

/** Answers through `respond`. A throw or a rejection becomes the request's error response. */
export type FrameRouteHandler = (
  request: ProtocolRequestEnvelope,
  origin: string,
  respond: ResponseCallback,
) => void | Promise<void>;

export type FrameRefusal =
  | { route: FrameRoute; reason: 'origin'; origin: string }
  | { route: FrameRoute; reason: 'failed'; request: ProtocolRequestEnvelope; error: unknown };

/** The iframe's window, or any target that dispatches `message` events. */
export type MessageTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface FrameRouterDeps {
  target: MessageTarget;
  isAllowedOrigin: (origin: string) => boolean;
  routes: Partial<Record<FrameRoute, FrameRouteHandler>>;
  /** Told of every request refused for its origin or failed by its handler, for logs and counts. */
  onRefused?: (refusal: FrameRefusal) => void;
}

export interface FrameRouter {
  /** Serves a route from now on, such as the chain engine once the protocol mode has booted. */
  setRoute: (route: FrameRoute, handler: FrameRouteHandler) => void;
  stop: () => void;
}

function routeOf(method: ProtocolRequestEnvelope['method']): FrameRoute {
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

export function createFrameRouter(deps: FrameRouterDeps): FrameRouter {
  const routes = new Map(Object.entries(deps.routes) as [FrameRoute, FrameRouteHandler][]);

  function onMessage(event: Event): void {
    if (!(event instanceof MessageEvent)) {
      return;
    }
    const data: unknown = event.data;
    if (!isProtocolEnvelope(data) || data.kind !== 'request') {
      return;
    }
    const route = routeOf(data.method);
    // A route not served yet drops its requests, as the host sends chain requests only after `ready`.
    const handler = routes.get(route);
    if (handler === undefined) {
      return;
    }
    const { origin, source } = event;
    if (!deps.isAllowedOrigin(origin)) {
      deps.onRefused?.({ route, reason: 'origin', origin });
      return;
    }

    const respond = (envelope: ProtocolEnvelope): void => {
      (source as Window | null)?.postMessage(envelope, origin);
    };
    const fail = (error: unknown): void => {
      deps.onRefused?.({ route, reason: 'failed', request: data, error });
      respond(errorResponse(data.id, error));
    };
    let pending: void | Promise<void>;
    try {
      pending = handler(data, origin, respond);
    } catch (error: unknown) {
      fail(error);
      return;
    }
    if (pending !== undefined) {
      pending.catch(fail);
    }
  }

  deps.target.addEventListener('message', onMessage);

  return {
    setRoute: (route, handler) => {
      routes.set(route, handler);
    },
    stop: () => {
      deps.target.removeEventListener('message', onMessage);
    },
  };
}
