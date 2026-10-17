// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The method table is the whole protocol: a method's position is its wire id, so new methods go at the end.

import { Bytes, Enum, Struct, _void, str, u8, type Codec, type CodecType } from 'scale-ts';
import type { ExecutableManifest, RootManifest } from '@dotli/resolver';
import { nullable, oneOf, safeInteger } from './codec-primitives.js';
import {
  chainDetailCodec,
  chainSyncEventCodec,
  executableManifestCodec,
  manifestResultCodec,
  resolvePhaseCodec,
  rootManifestCodec,
  smoldotDbChainCodec,
  smoldotDbOutcomeCodec,
} from './codec-values.js';

/**
 * Sent in the handshake. A peer on another version is refused, since a codec change is a wire change. Any wire change
 * bumps it, except to what a peer of any release must read to tell the versions apart, which never changes: the message
 * header, `handshake` first in the table with its payload and empty answer, and the response and error layout.
 */
export const WIRE_VERSION = 1;

interface RequestEntry<P, A> {
  kind: 'request';
  payload: Codec<P>;
  answer: Codec<A>;
}

interface SubscriptionEntry<P, E> {
  kind: 'subscription';
  payload: Codec<P>;
  event: Codec<E>;
  /** Whether an event is worth delivering. A decoded event that fails it is dropped as invalid. */
  check?: (event: E) => boolean;
}

function request<P, A>(payload: Codec<P>, answer: Codec<A>): RequestEntry<P, A> {
  return { kind: 'request', payload, answer };
}

function subscription<P, E>(
  payload: Codec<P>,
  event: Codec<E>,
  check?: (event: E) => boolean,
): SubscriptionEntry<P, E> {
  return check === undefined
    ? { kind: 'subscription', payload, event }
    : { kind: 'subscription', payload, event, check };
}

const siteKey = Struct({ siteId: str, key: str });
const siteKeyValue = Struct({ siteId: str, key: str, value: str });
const siteOnly = Struct({ siteId: str });
const label = Struct({ label: str });

const localWalletIdentityCodec = Struct({ identityAccountId: str, liteUsername: nullable(str) });

const localWalletReadCodec = Enum({
  none: _void,
  unreadable: _void,
  ok: Struct({ entropy: Bytes(), identity: nullable(localWalletIdentityCodec) }),
});

const telemetryEventCodec = Enum({
  chainSync: chainSyncEventCodec,
  chainDetail: chainDetailCodec,
  netBytes: safeInteger,
  smoldotDb: Struct({ chain: smoldotDbChainCodec, outcome: smoldotDbOutcomeCodec }),
});

const sharedAuthChangeCodec = Struct({ siteId: str, key: str, value: nullable(str) });

// Peer ids and roles land in telemetry attributes, so a spoofed frame could write unbounded junk into spans.
const MAX_PEER_ID_LENGTH = 128;
const MAX_PEERS = 50;
const MAX_SYNC_PEERS = 10_000;

function isTelemetryEventValid(event: TelemetryEvent): boolean {
  switch (event.tag) {
    case 'chainSync': {
      const { kind, peers } = event.value;
      return kind !== 'peers' || (peers !== undefined && peers <= MAX_SYNC_PEERS);
    }
    case 'chainDetail': {
      const peers = event.value.peers;
      return (
        peers === undefined ||
        (peers.length <= MAX_PEERS &&
          peers.every(
            peer =>
              peer.peerId.length > 0 &&
              peer.peerId.length <= MAX_PEER_ID_LENGTH &&
              peer.roles.length <= MAX_PEER_ID_LENGTH,
          ))
      );
    }
    case 'netBytes':
    case 'smoldotDb':
      return true;
  }
}

export const PROTOCOL_METHODS = {
  // Never moved or changed, so a peer of any release can read the version it refuses.
  handshake: request(Struct({ version: u8, resolutionId: nullable(str) }), _void),
  heartbeat: request(_void, _void),
  warmup: request(_void, _void),
  resolveOwner: request(label, nullable(str)),
  resolveExecutableManifest: request(
    Struct({ label: str, kind: oneOf(['app', 'widget', 'worker'] as const) }),
    manifestResultCodec<ExecutableManifest>(executableManifestCodec),
  ),
  resolveRootManifest: request(label, manifestResultCodec<RootManifest>(rootManifestCodec)),
  authStorageRead: request(siteKey, nullable(str)),
  authStorageWrite: request(siteKeyValue, _void),
  authStorageClear: request(siteKey, _void),
  modeStorageRead: request(siteKey, nullable(str)),
  modeStorageWrite: request(siteKeyValue, _void),
  modeStorageClear: request(siteKey, _void),
  localWalletRead: request(siteOnly, localWalletReadCodec),
  localWalletSave: request(Struct({ siteId: str, entropy: Bytes() }), _void),
  localWalletIdentity: request(Struct({ siteId: str, identity: localWalletIdentityCodec }), _void),
  localWalletForget: request(siteOnly, _void),
  chainSend: request(Struct({ connectionId: str, message: str }), _void),
  frameStatus: subscription(_void, _void),
  telemetry: subscription(_void, telemetryEventCodec, isTelemetryEventValid),
  sharedAuthChanges: subscription(_void, sharedAuthChangeCodec),
  chainConnect: subscription(Struct({ genesisHash: str, connectionId: str }), Enum({ connected: _void, message: str })),
  resolveDotName: subscription(label, Enum({ phase: resolvePhaseCodec, resolved: nullable(str) })),
  // Last, so the wire ids of the methods before it never move. The SharedWorker sends each beat from its own clock,
  // and a tab answers from the event, which a hidden page's timer throttling does not delay.
  beat: subscription(_void, _void),
};

export type ProtocolMethod = keyof typeof PROTOCOL_METHODS;
type Table = typeof PROTOCOL_METHODS;

/** The wire id of a method is its index here. */
export const METHOD_NAMES = Object.keys(PROTOCOL_METHODS) as ProtocolMethod[];

/** Every request method but the handshake, which only the transport sends. */
export type RequestMethod = Exclude<
  { [M in ProtocolMethod]: Table[M]['kind'] extends 'request' ? M : never }[ProtocolMethod],
  'handshake'
>;
export type SubscriptionMethod = {
  [M in ProtocolMethod]: Table[M]['kind'] extends 'subscription' ? M : never;
}[ProtocolMethod];

export type RequestPayload<M extends ProtocolMethod> = CodecType<Table[M]['payload']>;
export type Answer<M extends RequestMethod | 'handshake'> = Table[M] extends { answer: infer C }
  ? C extends Codec<infer T>
    ? T
    : never
  : never;
export type SubscribePayload<M extends SubscriptionMethod> = CodecType<Table[M]['payload']>;
export type SubscriptionEvent<M extends SubscriptionMethod> = Table[M] extends { event: infer C }
  ? C extends Codec<infer T>
    ? T
    : never
  : never;

export type LocalWalletIdentity = CodecType<typeof localWalletIdentityCodec>;
export type LocalWalletReadResult = CodecType<typeof localWalletReadCodec>;
export type TelemetryEvent = CodecType<typeof telemetryEventCodec>;
export type SharedAuthChange = CodecType<typeof sharedAuthChangeCodec>;
