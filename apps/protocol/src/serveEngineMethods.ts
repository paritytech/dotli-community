// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chain and name methods an engine serves, each under the name of its handler, so every side serves or forwards
// the same set.

import {
  protocolSchema,
  type DomainFailure,
  type ProtocolHello,
  type ProtocolServing,
  type SubscriptionEnd,
} from '@dotli/protocol';
import { getKeys } from '@dotli/shared';
import type { AnyMethod, Request, RequestHandler, Subscription, SubscriptionHandler } from '@dotli/transport';

import type { EngineScope, ProtocolEngine } from './createEngine.js';

/** What serves the chain and name methods: the engine and its scope, or the worker's wrapped handlers. */
export type EngineMethods = Omit<ProtocolEngine, 'openScope' | 'dispose'> & Pick<EngineScope, 'connect' | 'send'>;

/** One engine method, and how its `Handler` is registered. */
type EngineMethod<Handler> = {
  readonly method: AnyMethod;
  readonly serve: (serving: ProtocolServing, handler: Handler) => () => void;
};

type Params<Name extends keyof EngineMethods> = {
  /** Where the method is served. */
  serving: ProtocolServing;
  /** What serves it, under the method's name. */
  served: Pick<EngineMethods, Name>;
  /** The method's name. */
  name: Name;
};

const methods = protocolSchema.sections;

/** Each chain and name method under the name of its handler, so a method without a handler fails the build. */
const ENGINE: { readonly [Name in keyof EngineMethods]: EngineMethod<EngineMethods[Name]> } = {
  warmup: toRequestMethod(methods.frame.warmup),
  resolveDotName: toSubscriptionMethod(methods.resolve.dotName),
  resolveOwner: toRequestMethod(methods.resolve.owner),
  resolveExecutableManifest: toRequestMethod(methods.resolve.executableManifest),
  resolveRootManifest: toRequestMethod(methods.resolve.rootManifest),
  connect: toSubscriptionMethod(methods.chain.connect),
  send: toRequestMethod(methods.chain.send),
};

/** Every chain and name method, for a side that forwards them instead of serving them. */
export const ENGINE_METHODS: readonly AnyMethod[] = Object.values(ENGINE).map(({ method }) => method);

/**
 * Serves every chain and name method on `serving`, so no side can leave one out.
 *
 * Returns a stop that removes every handler it registered. The stop is safe to call twice.
 */
export function serveEngineMethods(serving: ProtocolServing, served: EngineMethods): () => void {
  const stops = getKeys(ENGINE).map(name => serveEngineMethod({ serving, served, name }));
  return stop;

  function stop(): void {
    for (const stopMethod of stops) {
      stopMethod();
    }
  }
}

/**
 * Serves a new scope of `engine` on `serving`: that scope's chain connections, and the engine's name reads.
 *
 * Returns the scope and a stop that removes the handlers and closes the scope. The stop is safe to call twice.
 */
export function serveEngineScope(
  serving: ProtocolServing,
  engine: ProtocolEngine,
): { scope: EngineScope; stop: () => void } {
  const scope = engine.openScope();
  const stopMethods = serveEngineMethods(serving, { ...engine, ...scope });
  return { scope, stop };

  function stop(): void {
    stopMethods();
    scope.close();
  }
}

function serveEngineMethod<Name extends keyof EngineMethods>({ serving, served, name }: Params<Name>): () => void {
  return ENGINE[name].serve(serving, served[name]);
}

/** A request method of the engine, served as a request. */
function toRequestMethod<Payload, Response, Domain extends DomainFailure>(
  method: Request<Payload, Response, Domain>,
): EngineMethod<RequestHandler<Payload, Response, Domain, ProtocolHello>> {
  return {
    method,
    serve: (serving, handler) => serving.handleRequest(method, handler),
  };
}

/** A subscription method of the engine, served as a subscription. */
function toSubscriptionMethod<Start, Value, Interrupt extends SubscriptionEnd<DomainFailure>>(
  method: Subscription<Start, Value, Interrupt>,
): EngineMethod<SubscriptionHandler<Start, Value, Interrupt, ProtocolHello>> {
  return {
    method,
    serve: (serving, handler) => serving.handleSubscription(method, handler),
  };
}
