// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol's methods as sections of a transport schema. New sections and methods go at the end, and any change to them
// bumps the version. Each subscription's interrupt is truapi's `Result<(), CallError>` of its reason, as the host's
// handlers and subscribers expect.

import { Bytes, Enum, Result, Struct, _void, bool, str, type CodecType, type ResultPayload } from 'scale-ts';
import {
  callError,
  defineSchema,
  request,
  subscription,
  type CallContext,
  type CallError,
  type DomainError,
  type MethodOf,
  type MethodTypes,
  type Request,
  type RequestHandler,
  type Subscription,
  type SubscriptionHandler,
  type Transport,
} from '@dotli/transport';
import type { ExecutableManifest, RootManifest } from '@dotli/resolver';
import {
  executableManifestCodec,
  manifestResultCodec,
  names,
  nullable,
  resolvePhaseCodec,
  rootManifestCodec,
  telemetryEventCodec,
} from './codec-values.js';

type ExecutableKind = ExecutableManifest['kind'];

const label = Struct({ label: str });
const siteKey = Struct({ siteId: str, key: str });
const siteKeyValue = Struct({ siteId: str, key: str, value: str });
const siteOnly = Struct({ siteId: str });
const nullableString = nullable(str);

const resolutionHello = Struct({ resolutionId: nullable(str) });

/** Why the frame's status ended, each with the error's message. */
const frameFailure = Enum({ fatal: str, initFailed: str, released: str, versionMismatch: str });

/** The remote errors the host's error screen tells apart, each with the error's message. */
const remoteFailure = Enum({ syncTimeout: str, apiStopped: str });

const localWalletIdentity = Struct({ identityAccountId: str, liteUsername: nullable(str) });

export type LocalWalletIdentity = CodecType<typeof localWalletIdentity>;

/** Whether `value` has the identity's shape, for one that reached the host without the codec. */
export function isLocalWalletIdentity(value: unknown): value is LocalWalletIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const { identityAccountId, liteUsername } = value as Record<string, unknown>;
  return typeof identityAccountId === 'string' && (liteUsername === null || typeof liteUsername === 'string');
}

/**
 * The entropy sizes a recovery phrase can encode, in bytes. The codec takes any bytes, so whoever stores or takes a
 * wallet checks them.
 */
const ENTROPY_LENGTHS: ReadonlySet<number> = new Set([16, 20, 24, 28, 32]);

/** Whether `entropy` has a size a recovery phrase can have. */
export function isLocalWalletEntropy(entropy: Uint8Array): boolean {
  return ENTROPY_LENGTHS.has(entropy.length);
}

const localWalletRead = Enum({
  none: _void,
  unreadable: _void,
  // The version changes with every save, so a forget can name the record it read.
  ok: Struct({ entropy: Bytes(), identity: nullable(localWalletIdentity), version: Bytes() }),
});

/** What the frame answers a local wallet read with. */
export type LocalWalletRead = CodecType<typeof localWalletRead>;

export const protocolSchema = defineSchema({
  version: 5,
  hello: resolutionHello,
  sections: {
    frame: {
      status: subscription({ start: _void, receive: _void, interrupt: Result(_void, callError(frameFailure)) }),
      heartbeat: request({ request: _void, response: _void }),
      // The SharedWorker sends each beat from its own clock, and a tab answers from the event, which a hidden page's
      // timer throttling does not delay.
      beat: subscription({ start: _void, receive: _void, interrupt: Result(_void, callError(_void)) }),
      warmup: request({ request: _void, response: _void }),
      telemetry: subscription({
        start: _void,
        receive: telemetryEventCodec,
        interrupt: Result(_void, callError(_void)),
      }),
    },
    resolve: {
      owner: request({ request: label, response: nullableString, error: remoteFailure }),
      executableManifest: request({
        request: Struct({
          label: str,
          kind: names<ExecutableKind>(Enum({ app: _void, widget: _void, worker: _void })),
        }),
        response: manifestResultCodec<ExecutableManifest>(executableManifestCodec),
        error: remoteFailure,
      }),
      rootManifest: request({
        request: label,
        response: manifestResultCodec<RootManifest>(rootManifestCodec),
        error: remoteFailure,
      }),
      dotName: subscription({
        start: label,
        receive: Enum({ phase: resolvePhaseCodec, resolved: nullable(str) }),
        interrupt: Result(_void, callError(remoteFailure)),
      }),
    },
    storage: {
      authRead: request({ request: siteKey, response: nullableString }),
      // Answers whether it changed the value. An equal value is neither written nor told to other tabs.
      authWrite: request({ request: siteKeyValue, response: bool }),
      authClear: request({ request: siteKey, response: _void }),
      authChanges: subscription({
        start: _void,
        // A `session` change is one auth key's new value. A `wallet` change says the local wallet record changed.
        receive: Enum({
          session: Struct({ siteId: str, key: str, value: nullable(str) }),
          wallet: Struct({ siteId: str }),
        }),
        interrupt: Result(_void, callError(_void)),
      }),
      modeRead: request({ request: siteKey, response: nullableString }),
      modeWrite: request({ request: siteKeyValue, response: bool }),
      modeClear: request({ request: siteKey, response: _void }),
      // Clears the key only while it holds `value`, in one step on the frame's store, and answers whether it did.
      authClearIf: request({ request: siteKeyValue, response: bool }),
    },
    wallet: {
      read: request({ request: siteOnly, response: localWalletRead }),
      save: request({
        request: Struct({ siteId: str, entropy: Bytes(), identity: nullable(localWalletIdentity) }),
        response: _void,
      }),
      identity: request({
        request: Struct({ siteId: str, identity: localWalletIdentity }),
        response: _void,
      }),
      forget: request({ request: siteOnly, response: _void }),
      // Forgets the wallet only while it is still the record of `version`, and answers whether it did.
      forgetIf: request({ request: Struct({ siteId: str, version: Bytes() }), response: bool }),
    },
    chain: {
      send: request({ request: Struct({ connectionId: str, message: str }), response: _void }),
      connect: subscription({
        start: Struct({ genesisHash: str, connectionId: str }),
        receive: Enum({ connected: _void, message: str }),
        interrupt: Result(_void, callError(remoteFailure)),
      }),
    },
  },
});

export type ProtocolSchema = typeof protocolSchema;
/** What each side of the protocol says in the handshake. */
export type ProtocolHello = CodecType<typeof resolutionHello>;
export type ProtocolTransport = Transport<ProtocolHello>;
export type ProtocolContext = CallContext<ProtocolHello>;

/** Why the frame's status ended. */
export type FrameFailure = CodecType<typeof frameFailure>;
/** The remote errors name resolution and chain connections fail with. */
export type RemoteFailure = DomainError<typeof protocolSchema.sections.resolve.owner>;
/** A shared auth write a sibling tab made. */
export type SharedAuthChange = MethodTypes<typeof protocolSchema.sections.storage.authChanges>['receive'];
/** How a protocol subscription ends: `Ok` for a clean end, or a `CallError` of its reason `E`. */
export type SubscriptionEnd<E> = ResultPayload<undefined, CallError<E>>;

/** A method's own `Domain` error: a request's error, or the reason of a subscription's end. */
type DomainOf<M> = M extends Subscription<infer _S, infer _V, SubscriptionEnd<infer E>> ? E : DomainError<M>;

/** Every domain error the schema declares, and the empty one of a method that declares none. */
export type DomainFailure = DomainOf<MethodOf<ProtocolSchema['sections']>>;

/** What serves `method` of the protocol. */
export type ProtocolHandler<M> =
  M extends Request<infer P, infer R, infer E>
    ? RequestHandler<P, R, E, ProtocolHello>
    : M extends Subscription<infer S, infer V, infer I>
      ? SubscriptionHandler<S, V, I, ProtocolHello>
      : never;

/** What serves the protocol's methods, each of whose own errors the schema declares. A transport is one. */
export type ProtocolServing = {
  handleRequest<P, R, E extends DomainFailure>(
    method: Request<P, R, E>,
    handler: RequestHandler<NoInfer<P>, NoInfer<R>, NoInfer<E>, ProtocolHello>,
  ): () => void;
  handleSubscription<S, V, I extends SubscriptionEnd<DomainFailure>>(
    method: Subscription<S, V, I>,
    handler: SubscriptionHandler<NoInfer<S>, NoInfer<V>, NoInfer<I>, ProtocolHello>,
  ): () => void;
};
