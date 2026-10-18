// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol's methods as traits of a transport schema. New traits and methods go at the end, and any change to them
// bumps the version.

import { Bytes, Enum, Struct, _void, str, type Codec, type CodecType } from 'scale-ts';
import {
  defineSchema,
  request,
  subscription,
  type CallContext,
  type DomainError,
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

export type { TelemetryEvent } from './codec-values.js';

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

const localWalletRead = Enum({
  none: _void,
  unreadable: _void,
  ok: Struct({ entropy: Bytes(), identity: nullable(localWalletIdentity) }),
});

/** What the frame answers a local wallet read with. */
export type LocalWalletRead = CodecType<typeof localWalletRead>;

export const protocolSchema = defineSchema({
  version: 4,
  hello: resolutionHello,
  traits: {
    frame: {
      status: subscription({ start: _void, receive: _void, interrupt: frameFailure }),
      heartbeat: request({ request: _void, response: _void }),
      // The SharedWorker sends each beat from its own clock, and a tab answers from the event, which a hidden page's
      // timer throttling does not delay.
      beat: subscription({ start: _void, receive: _void }),
      warmup: request({ request: _void, response: _void }),
      telemetry: subscription({ start: _void, receive: telemetryEventCodec }),
    },
    resolve: {
      owner: request({ request: label, response: nullableString, error: remoteFailure }),
      executableManifest: request({
        request: Struct({
          label: str,
          kind: names<ExecutableKind>(
            Enum({ app: _void, widget: _void, worker: _void } satisfies Record<ExecutableKind, Codec<undefined>>),
          ),
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
        interrupt: remoteFailure,
      }),
    },
    storage: {
      authRead: request({ request: siteKey, response: nullableString }),
      authWrite: request({ request: siteKeyValue, response: _void }),
      authClear: request({ request: siteKey, response: _void }),
      authChanges: subscription({
        start: _void,
        receive: Struct({ siteId: str, key: str, value: nullable(str) }),
      }),
      modeRead: request({ request: siteKey, response: nullableString }),
      modeWrite: request({ request: siteKeyValue, response: _void }),
      modeClear: request({ request: siteKey, response: _void }),
    },
    wallet: {
      read: request({ request: siteOnly, response: localWalletRead }),
      save: request({ request: Struct({ siteId: str, entropy: Bytes() }), response: _void }),
      identity: request({
        request: Struct({ siteId: str, identity: localWalletIdentity }),
        response: _void,
      }),
      forget: request({ request: siteOnly, response: _void }),
    },
    chain: {
      send: request({ request: Struct({ connectionId: str, message: str }), response: _void }),
      connect: subscription({
        start: Struct({ genesisHash: str, connectionId: str }),
        receive: Enum({ connected: _void, message: str }),
        interrupt: remoteFailure,
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
export type FrameFailure = DomainError<typeof protocolSchema.traits.frame.status>;
/** The remote errors name resolution and chain connections fail with. */
export type RemoteFailure = DomainError<typeof protocolSchema.traits.resolve.owner>;
/** A shared auth write a sibling tab made. */
export type SharedAuthChange = MethodTypes<typeof protocolSchema.traits.storage.authChanges>['receive'];
/** Every domain error the schema declares, and the empty one of a method that declares none. */
export type DomainFailure = FrameFailure | RemoteFailure | undefined;

/** What serves `method` of the protocol. */
export type ProtocolHandler<M> =
  M extends Request<infer P, infer R, infer E>
    ? RequestHandler<P, R, E, ProtocolHello>
    : M extends Subscription<infer S, infer V, infer I>
      ? SubscriptionHandler<S, V, I, ProtocolHello>
      : never;

/** What serves the protocol's methods, each of whose own errors the schema declares. A transport is one. */
export interface ProtocolServing {
  handleRequest<P, R, E extends DomainFailure>(
    method: Request<P, R, E>,
    handler: RequestHandler<NoInfer<P>, NoInfer<R>, NoInfer<E>, ProtocolHello>,
  ): () => void;
  handleSubscription<S, V, I extends DomainFailure>(
    method: Subscription<S, V, I>,
    handler: SubscriptionHandler<NoInfer<S>, NoInfer<V>, NoInfer<I>, ProtocolHello>,
  ): () => void;
}
