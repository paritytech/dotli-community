// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol's methods as traits of a transport schema. New traits and methods go at the end, and any change to them
// bumps the version.

import { Bytes, Enum, Struct, _void, str, type Codec as ScaleCodec, type CodecType } from 'scale-ts';
import {
  codec,
  defineSchema,
  none,
  request,
  subscription,
  type CallContext,
  type Codec,
  type DomainError,
  type MethodTypes,
  type SubscriptionMethodName,
  type TraitName,
  type Transport,
} from '@dotli/transport';
import type { ExecutableManifest, RootManifest } from '@dotli/resolver';
import { decodeExact, nullable, oneOf } from './codec-primitives.js';
import {
  executableManifestCodec,
  manifestResultCodec,
  resolvePhaseCodec,
  rootManifestCodec,
  telemetryEventCodec,
} from './codec-values.js';

export type { TelemetryEvent } from './codec-values.js';

/**
 * A scale-ts codec as a transport codec. Decoding throws unless the value ends exactly where the payload does. It
 * decodes a copy, since scale-ts reads a view's whole buffer and ignores its offset, and a payload sits after a header.
 */
function scaleCodec<T>(c: ScaleCodec<T>): Codec<T> {
  return codec(c.enc, bytes => decodeExact(c.dec, bytes.slice().buffer));
}

const label = scaleCodec(Struct({ label: str }));
const siteKey = scaleCodec(Struct({ siteId: str, key: str }));
const siteKeyValue = scaleCodec(Struct({ siteId: str, key: str, value: str }));
const siteOnly = scaleCodec(Struct({ siteId: str }));
const nullableString = scaleCodec(nullable(str));

const resolutionHello = scaleCodec(Struct({ resolutionId: nullable(str) }));

/** Why the frame's status ended, each with the error's message. */
const frameFailure = scaleCodec(Enum({ fatal: str, initFailed: str, released: str, versionMismatch: str }));

/** The remote errors the host's error screen tells apart, each with the error's message. */
const remoteFailure = scaleCodec(Enum({ syncTimeout: str, apiStopped: str }));

const localWalletIdentity = Struct({ identityAccountId: str, liteUsername: nullable(str) });

export type LocalWalletIdentity = CodecType<typeof localWalletIdentity>;

const localWalletRead = scaleCodec(
  Enum({
    none: _void,
    unreadable: _void,
    ok: Struct({ entropy: Bytes(), identity: nullable(localWalletIdentity) }),
  }),
);

export const protocolSchema = defineSchema({
  version: 3,
  hello: resolutionHello,
  traits: {
    frame: {
      status: subscription({ start: none, receive: none, interrupt: frameFailure }),
      heartbeat: request({ request: none, response: none }),
      // The SharedWorker sends each beat from its own clock, and a tab answers from the event, which a hidden page's
      // timer throttling does not delay.
      beat: subscription({ start: none, receive: none }),
      warmup: request({ request: none, response: none }),
      telemetry: subscription({ start: none, receive: scaleCodec(telemetryEventCodec) }),
    },
    resolve: {
      owner: request({ request: label, response: nullableString, error: remoteFailure }),
      executableManifest: request({
        request: scaleCodec(Struct({ label: str, kind: oneOf(['app', 'widget', 'worker'] as const) })),
        response: scaleCodec(manifestResultCodec<ExecutableManifest>(executableManifestCodec)),
        error: remoteFailure,
      }),
      rootManifest: request({
        request: label,
        response: scaleCodec(manifestResultCodec<RootManifest>(rootManifestCodec)),
        error: remoteFailure,
      }),
      dotName: subscription({
        start: label,
        receive: scaleCodec(Enum({ phase: resolvePhaseCodec, resolved: nullable(str) })),
        interrupt: remoteFailure,
      }),
    },
    storage: {
      authRead: request({ request: siteKey, response: nullableString }),
      authWrite: request({ request: siteKeyValue, response: none }),
      authClear: request({ request: siteKey, response: none }),
      authChanges: subscription({
        start: none,
        receive: scaleCodec(Struct({ siteId: str, key: str, value: nullable(str) })),
      }),
      modeRead: request({ request: siteKey, response: nullableString }),
      modeWrite: request({ request: siteKeyValue, response: none }),
      modeClear: request({ request: siteKey, response: none }),
    },
    wallet: {
      read: request({ request: siteOnly, response: localWalletRead }),
      save: request({ request: scaleCodec(Struct({ siteId: str, entropy: Bytes() })), response: none }),
      identity: request({
        request: scaleCodec(Struct({ siteId: str, identity: localWalletIdentity })),
        response: none,
      }),
      forget: request({ request: siteOnly, response: none }),
    },
    chain: {
      send: request({ request: scaleCodec(Struct({ connectionId: str, message: str })), response: none }),
      connect: subscription({
        start: scaleCodec(Struct({ genesisHash: str, connectionId: str })),
        receive: scaleCodec(Enum({ connected: _void, message: str })),
        interrupt: remoteFailure,
      }),
    },
  },
});

export type ProtocolSchema = typeof protocolSchema;
export type ProtocolTransport = Transport<ProtocolSchema>;
export type ProtocolContext = CallContext<ProtocolSchema>;

/** Why the frame's status ended. */
export type FrameFailure = DomainError<ProtocolSchema, 'frame', 'status'>;
/** The remote errors name resolution and chain connections fail with. */
export type RemoteFailure = DomainError<ProtocolSchema, 'resolve', 'owner'>;
/** What a subscription of `method` in `trait` starts with. */
export type SubscriptionStart<
  T extends TraitName<ProtocolSchema>,
  M extends SubscriptionMethodName<ProtocolSchema, T>,
> = MethodTypes<ProtocolSchema, T, M> extends { start: infer St } ? St : never;
/** What a subscription of `method` in `trait` sends. */
export type SubscriptionValue<
  T extends TraitName<ProtocolSchema>,
  M extends SubscriptionMethodName<ProtocolSchema, T>,
> = MethodTypes<ProtocolSchema, T, M> extends { receive: infer V } ? V : never;

/** A shared auth write a sibling tab made. */
export type SharedAuthChange = MethodTypes<ProtocolSchema, 'storage', 'authChanges'>['receive'];
