// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Wire codecs for the chain, resolver and manifest values the frame carries. An absent optional field stays absent
// after decoding, and a manifest's `$v` is not sent because only version 1 is carried.

import { Enum, Struct, Tuple, Vector, _void, enhanceCodec, str, type Codec } from 'scale-ts';
import type {
  ChainDetail,
  ChainPeer,
  ChainSyncEvent,
  ChainSyncKind,
  SmoldotDbChain,
  SmoldotDbOutcome,
} from '@dotli/chains';
import type { ChainRole } from '@dotli/config';
import type { ExecutableManifest, ManifestResult, ResolvePhase, RootManifest } from '@dotli/resolver';
import { f64, oneOf, strictBool, strictOption, u32Exact } from './codec-primitives.js';

const CHAIN_ROLES = Object.keys({
  relay: true,
  assethub: true,
  bulletin: true,
  people: true,
} satisfies Record<ChainRole, true>) as ChainRole[];

const SMOLDOT_DB_CHAINS = Object.keys({
  relay: true,
  assethub: true,
  bulletin: true,
} satisfies Record<SmoldotDbChain, true>) as SmoldotDbChain[];

const SMOLDOT_DB_OUTCOMES = Object.keys({
  hit: true,
  miss: true,
  unavailable: true,
} satisfies Record<SmoldotDbOutcome, true>) as SmoldotDbOutcome[];

const CHAIN_SYNC_KINDS = Object.keys({
  firstPeer: true,
  bootstrapComplete: true,
  stalled: true,
  recovered: true,
  peers: true,
  connecting: true,
  warpSyncProgress: true,
  warpSyncFinished: true,
} satisfies Record<ChainSyncKind, true>) as ChainSyncKind[];

const RESOLVE_PHASES = Object.keys({
  'asset-hub-connecting': true,
  'asset-hub-syncing': true,
  'asset-hub-ready': true,
  'resolving-content': true,
} satisfies Record<ResolvePhase, true>) as ResolvePhase[];

export const chainRoleCodec: Codec<ChainRole> = oneOf(CHAIN_ROLES);
export const smoldotDbChainCodec: Codec<SmoldotDbChain> = oneOf(SMOLDOT_DB_CHAINS);
export const smoldotDbOutcomeCodec: Codec<SmoldotDbOutcome> = oneOf(SMOLDOT_DB_OUTCOMES);
export const chainSyncKindCodec: Codec<ChainSyncKind> = oneOf(CHAIN_SYNC_KINDS);
export const resolvePhaseCodec: Codec<ResolvePhase> = oneOf(RESOLVE_PHASES);

/** `Option` decodes to `undefined`, which `exactOptionalPropertyTypes` does not accept as an absent field. */
// The result type is the caller's claim, since the filter cannot prove which keys survive.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T only names the caller's target type
function dropUndefined<T>(wire: object): T {
  return Object.fromEntries(Object.entries(wire).filter(([, value]) => value !== undefined)) as T;
}

const chainSyncEventWire = Struct({
  chain: chainRoleCodec,
  kind: chainSyncKindCodec,
  reason: strictOption(str),
  peers: strictOption(u32Exact),
  isSyncing: strictOption(strictBool),
  at: strictOption(u32Exact),
  target: strictOption(u32Exact),
  finalized: strictOption(u32Exact),
});

export const chainSyncEventCodec: Codec<ChainSyncEvent> = enhanceCodec(
  chainSyncEventWire,
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
  wire => dropUndefined<ChainSyncEvent>(wire),
);

const chainPeerCodec: Codec<ChainPeer> = Struct({ peerId: str, roles: str, bestNumber: u32Exact });

const chainDetailWire = Struct({
  chain: chainRoleCodec,
  dbCache: strictOption(oneOf(['hit', 'miss'] as const)),
  peers: strictOption(Vector(chainPeerCodec)),
});

export const chainDetailCodec: Codec<ChainDetail> = enhanceCodec(
  chainDetailWire,
  (detail: ChainDetail) => ({ chain: detail.chain, dbCache: detail.dbCache, peers: detail.peers }),
  wire => dropUndefined<ChainDetail>(wire),
);

const rootManifestWire = Struct({
  displayName: str,
  description: str,
  icon: Struct({ cid: str, format: str }),
  trustedProducts: strictOption(Vector(Tuple(str, Vector(str)))),
});

export const rootManifestCodec: Codec<RootManifest> = enhanceCodec(
  rootManifestWire,
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
  (wire): RootManifest => {
    const { trustedProducts, ...rest } = wire;
    return {
      $v: 1,
      ...rest,
      ...(trustedProducts === undefined ? {} : { trustedProducts: Object.fromEntries(trustedProducts) }),
    };
  },
);

const appVersionCodec = Tuple(f64, f64, f64, strictOption(str));

const widgetDimensionsCodec = Struct({ height: Vector(f64), width: strictOption(f64) });

const workerIncludesCodec = Struct({
  chat: strictOption(strictBool),
  pocket: strictOption(strictBool),
  input: strictOption(strictBool),
});

const executableManifestWire = Enum({
  app: Struct({ appVersion: appVersionCodec }),
  widget: Struct({
    appVersion: appVersionCodec,
    description: strictOption(str),
    dimensions: widgetDimensionsCodec,
  }),
  worker: Struct({
    appVersion: appVersionCodec,
    entrypoint: str,
    includes: workerIncludesCodec,
  }),
});

type WireAppVersion = [number, number, number, string | undefined];

function toWireAppVersion(version: ExecutableManifest['appVersion']): WireAppVersion {
  return [version[0], version[1], version[2], version.length === 4 ? version[3] : undefined];
}

function fromWireAppVersion([major, minor, patch, build]: WireAppVersion): ExecutableManifest['appVersion'] {
  return build === undefined ? [major, minor, patch] : [major, minor, patch, build];
}

export const executableManifestCodec: Codec<ExecutableManifest> = enhanceCodec(
  executableManifestWire,
  (manifest: ExecutableManifest) => {
    const appVersion = toWireAppVersion(manifest.appVersion);
    switch (manifest.kind) {
      case 'app':
        return { tag: 'app' as const, value: { appVersion } };
      case 'widget':
        return {
          tag: 'widget' as const,
          value: {
            appVersion,
            description: manifest.description,
            dimensions: {
              height: [...manifest.dimensions.height],
              width: manifest.dimensions.width,
            },
          },
        };
      case 'worker':
        return {
          tag: 'worker' as const,
          value: {
            appVersion,
            entrypoint: manifest.entrypoint,
            includes: {
              chat: manifest.includes.chat,
              pocket: manifest.includes.pocket,
              input: manifest.includes.input,
            },
          },
        };
    }
  },
  (wire): ExecutableManifest => {
    const appVersion = fromWireAppVersion(wire.value.appVersion);
    switch (wire.tag) {
      case 'app':
        return { $v: 1, kind: 'app', appVersion };
      case 'widget':
        return {
          $v: 1,
          kind: 'widget',
          appVersion,
          ...dropUndefined<{ description?: string }>({ description: wire.value.description }),
          dimensions: dropUndefined({ ...wire.value.dimensions }),
        };
      case 'worker':
        return {
          $v: 1,
          kind: 'worker',
          appVersion,
          entrypoint: wire.value.entrypoint,
          includes: dropUndefined({ ...wire.value.includes }),
        };
    }
  },
);

/** `unsupported-version.version` is any JSON value. Empty text stands for `undefined`, which JSON cannot spell. */
const jsonTextCodec: Codec<unknown> = enhanceCodec(
  str,
  (value: unknown) => (value === undefined ? '' : ((JSON.stringify(value) as string | undefined) ?? '')),
  (text: string): unknown => (text === '' ? undefined : JSON.parse(text)),
);

export function manifestResultCodec<T>(value: Codec<T>): Codec<ManifestResult<T>> {
  const wire = Enum({
    ok: Struct({ value, raw: str }),
    empty: _void,
    unsupported: Struct({ reason: str }),
    'unsupported-version': Struct({ version: jsonTextCodec, raw: str }),
    invalid: Struct({ errors: Vector(str), raw: str }),
  });
  return enhanceCodec(
    wire,
    (result: ManifestResult<T>) => {
      switch (result.kind) {
        case 'ok':
          return { tag: 'ok' as const, value: { value: result.value, raw: result.raw } };
        case 'empty':
          return { tag: 'empty' as const, value: undefined };
        case 'unsupported':
          return { tag: 'unsupported' as const, value: { reason: result.reason } };
        case 'unsupported-version':
          return {
            tag: 'unsupported-version' as const,
            value: { version: result.version, raw: result.raw },
          };
        case 'invalid':
          return { tag: 'invalid' as const, value: { errors: result.errors, raw: result.raw } };
      }
    },
    (decoded): ManifestResult<T> => {
      switch (decoded.tag) {
        case 'ok':
          return { kind: 'ok', value: decoded.value.value, raw: decoded.value.raw };
        case 'empty':
          return { kind: 'empty' };
        case 'unsupported':
          return { kind: 'unsupported', reason: decoded.value.reason };
        case 'unsupported-version':
          return { kind: 'unsupported-version', version: decoded.value.version, raw: decoded.value.raw };
        case 'invalid':
          return { kind: 'invalid', errors: decoded.value.errors, raw: decoded.value.raw };
      }
    },
  );
}
