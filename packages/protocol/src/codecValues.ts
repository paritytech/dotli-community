// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Wire codecs for the chain, resolver and manifest values the frame carries, composed from scale-ts. A manifest's `$v`
// is not sent because only version 1 is carried.

import {
  Enum,
  Option,
  Struct,
  Tuple,
  Vector,
  _void,
  bool,
  compact,
  enhanceCodec,
  str,
  u32,
  type Codec,
  type CodecType,
} from 'scale-ts';
import type {
  ChainDetail,
  ChainPeer,
  ChainSyncEvent,
  ChainSyncKind,
  SmoldotDbChain,
  SmoldotDbOutcome,
} from '@dotli/chains';
import type { ChainRole } from '@dotli/config';
import type { AppVersion, ExecutableManifest, ManifestResult, ResolvePhase, RootManifest } from '@dotli/resolver';

/**
 * The codec of each field of `T`. Held to the type with `satisfies`, so a field added to the type fails the build until
 * the wire carries it.
 */
type CodecsOf<T> = { [K in keyof T]-?: Codec<T[K]> };

type WidgetManifest = Extract<ExecutableManifest, { kind: 'widget' }>;
type WorkerManifest = Extract<ExecutableManifest, { kind: 'worker' }>;

/** A string union as an enum of empty variants, read and written as the variant's name. */
export function names<T extends string>(variants: Codec<{ tag: T; value: undefined }>): Codec<T> {
  return enhanceCodec(
    variants,
    (tag: T) => ({ tag, value: undefined }),
    ({ tag }) => tag,
  );
}

/** An `Option` read and written as `null` for none. */
export function nullable<T>(inner: Codec<T>): Codec<T | null> {
  return enhanceCodec<T | undefined, T | null>(
    Option(inner),
    value => value ?? undefined,
    value => value ?? null,
  );
}

/** A whole number of any size, as SCALE's compact. */
const count: Codec<number> = enhanceCodec(compact, (value: number) => value, Number);

const chainRoleCodec = names<ChainRole>(Enum({ relay: _void, assethub: _void, bulletin: _void, people: _void }));

const smoldotDbChainCodec = names<SmoldotDbChain>(Enum({ relay: _void, assethub: _void, bulletin: _void }));

const smoldotDbOutcomeCodec = names<SmoldotDbOutcome>(Enum({ hit: _void, miss: _void, unavailable: _void }));

const chainSyncKindCodec = names<ChainSyncKind>(
  Enum({
    firstPeer: _void,
    bootstrapComplete: _void,
    stalled: _void,
    recovered: _void,
    peers: _void,
    connecting: _void,
    warpSyncProgress: _void,
    warpSyncFinished: _void,
  }),
);

export const resolvePhaseCodec = names<ResolvePhase>(
  Enum({
    'asset-hub-connecting': _void,
    'asset-hub-syncing': _void,
    'asset-hub-ready': _void,
    'resolving-content': _void,
  }),
);

const dbCacheCodec = names<NonNullable<ChainDetail['dbCache']>>(Enum({ hit: _void, miss: _void }));

// An event leaves out the fields its kind does not use, which the wire still carries as none.
const chainSyncEventCodec: Codec<ChainSyncEvent> = enhanceCodec(
  Struct({
    chain: chainRoleCodec,
    kind: chainSyncKindCodec,
    reason: Option(str),
    peers: Option(u32),
    isSyncing: Option(bool),
    at: Option(u32),
    target: Option(u32),
    finalized: Option(u32),
  } satisfies CodecsOf<ChainSyncEvent>),
  (event: ChainSyncEvent) => ({
    chain: event.chain,
    kind: event.kind,
    reason: event.reason,
    peers: event.peers,
    isSyncing: event.isSyncing,
    at: event.at,
    target: event.target,
    finalized: event.finalized,
  }),
  (event): ChainSyncEvent => event,
);

const chainPeerCodec = Struct({ peerId: str, roles: str, bestNumber: u32 } satisfies CodecsOf<ChainPeer>);

const chainDetailCodec: Codec<ChainDetail> = enhanceCodec(
  Struct({
    chain: chainRoleCodec,
    dbCache: Option(dbCacheCodec),
    peers: Option(Vector(chainPeerCodec)),
  } satisfies CodecsOf<ChainDetail>),
  (detail: ChainDetail) => ({ chain: detail.chain, dbCache: detail.dbCache, peers: detail.peers }),
  (detail): ChainDetail => detail,
);

// Trusted products cross as entries, since a record has no SCALE form of its own.
export const rootManifestCodec: Codec<RootManifest> = enhanceCodec(
  Struct({
    displayName: str,
    description: str,
    icon: Struct({ cid: str, format: str }),
    trustedProducts: Option(Vector(Tuple(str, Vector(str)))),
  }),
  (manifest: RootManifest) => ({
    displayName: manifest.displayName,
    description: manifest.description,
    icon: manifest.icon,
    trustedProducts:
      manifest.trustedProducts === undefined
        ? undefined
        : Object.entries(manifest.trustedProducts).map(([product, grants]): [string, string[]] => [
            product,
            [...grants],
          ]),
  }),
  ({ trustedProducts, ...manifest }): RootManifest => ({
    $v: 1,
    ...manifest,
    trustedProducts: trustedProducts === undefined ? undefined : Object.fromEntries(trustedProducts),
  }),
);

// An app version has three numbers and an optional build, which crosses as an option.
const appVersionCodec: Codec<AppVersion> = enhanceCodec(
  Tuple(count, count, count, Option(str)),
  (version: AppVersion): [number, number, number, string | undefined] => [
    version[0],
    version[1],
    version[2],
    version[3],
  ],
  ([major, minor, patch, build]): AppVersion =>
    build === undefined ? [major, minor, patch] : [major, minor, patch, build],
);

const dimensionsCodec: Codec<WidgetManifest['dimensions']> = enhanceCodec(
  Struct({ height: Vector(count), width: Option(count) }),
  (dimensions: WidgetManifest['dimensions']) => ({ height: [...dimensions.height], width: dimensions.width }),
  (dimensions): WidgetManifest['dimensions'] => dimensions,
);

const includesCodec: Codec<WorkerManifest['includes']> = enhanceCodec(
  Struct({ chat: Option(bool), pocket: Option(bool), input: Option(bool) }),
  (includes: WorkerManifest['includes']) => ({ chat: includes.chat, pocket: includes.pocket, input: includes.input }),
  (includes): WorkerManifest['includes'] => includes,
);

export const executableManifestCodec: Codec<ExecutableManifest> = enhanceCodec(
  Enum({
    app: Struct({ appVersion: appVersionCodec }),
    widget: Struct({ appVersion: appVersionCodec, description: Option(str), dimensions: dimensionsCodec }),
    worker: Struct({ appVersion: appVersionCodec, entrypoint: str, includes: includesCodec }),
  }),
  (manifest: ExecutableManifest) => {
    switch (manifest.kind) {
      case 'app':
        return { tag: 'app' as const, value: { appVersion: manifest.appVersion } };
      case 'widget':
        return {
          tag: 'widget' as const,
          value: {
            appVersion: manifest.appVersion,
            description: manifest.description,
            dimensions: manifest.dimensions,
          },
        };
      case 'worker':
        return {
          tag: 'worker' as const,
          value: { appVersion: manifest.appVersion, entrypoint: manifest.entrypoint, includes: manifest.includes },
        };
    }
  },
  (wire): ExecutableManifest => {
    switch (wire.tag) {
      case 'app':
        return { $v: 1, kind: 'app', ...wire.value };
      case 'widget':
        return { $v: 1, kind: 'widget', ...wire.value };
      case 'worker':
        return { $v: 1, kind: 'worker', ...wire.value };
    }
  },
);

export function manifestResultCodec<T>(value: Codec<T>): Codec<ManifestResult<T>> {
  return enhanceCodec(
    Enum({
      ok: Struct({ value, raw: str }),
      empty: _void,
      unsupported: Struct({ reason: str }),
      'unsupported-version': Struct({ version: str, raw: str }),
      invalid: Struct({ errors: Vector(str), raw: str }),
    }),
    (result: ManifestResult<T>) => {
      switch (result.kind) {
        case 'ok':
          return { tag: 'ok' as const, value: { value: result.value, raw: result.raw } };
        case 'empty':
          return { tag: 'empty' as const, value: undefined };
        case 'unsupported':
          return { tag: 'unsupported' as const, value: { reason: result.reason } };
        case 'unsupported-version':
          return { tag: 'unsupported-version' as const, value: { version: result.version, raw: result.raw } };
        case 'invalid':
          return { tag: 'invalid' as const, value: { errors: result.errors, raw: result.raw } };
      }
    },
    (decoded): ManifestResult<T> => {
      switch (decoded.tag) {
        case 'ok':
          return { kind: 'ok', ...decoded.value };
        case 'empty':
          return { kind: 'empty' };
        case 'unsupported':
          return { kind: 'unsupported', ...decoded.value };
        case 'unsupported-version':
          return { kind: 'unsupported-version', ...decoded.value };
        case 'invalid':
          return { kind: 'invalid', ...decoded.value };
      }
    },
  );
}

const telemetryEventWire = Enum({
  chainSync: chainSyncEventCodec,
  chainDetail: chainDetailCodec,
  netBytes: count,
  smoldotDb: Struct({ chain: smoldotDbChainCodec, outcome: smoldotDbOutcomeCodec }),
});

/** What the frame reports on its telemetry feed. */
export type TelemetryEvent = CodecType<typeof telemetryEventWire>;

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

/** A telemetry event. Decoding throws on one past the limits, so the transport refuses it as malformed. */
export const telemetryEventCodec: Codec<TelemetryEvent> = enhanceCodec(
  telemetryEventWire,
  (event: TelemetryEvent) => event,
  (event: TelemetryEvent) => {
    if (!isTelemetryEventValid(event)) {
      throw new RangeError(`a ${event.tag} event is past the telemetry limits`);
    }
    return event;
  },
);
