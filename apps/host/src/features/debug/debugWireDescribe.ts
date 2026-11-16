// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Tags and decodes wire frames for the debug panel. Chain frames get `remote_chain_*` tags, the names the panel keys on.

import * as WIRE_TABLE from '@parity/truapi/wire-table';
import * as generated from '@parity/truapi';
import {
  MESSAGE_TYPE_INTERRUPT,
  MESSAGE_TYPE_RECEIVE,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  MESSAGE_TYPE_START,
  MESSAGE_TYPE_STOP,
  type MethodIds,
} from '@parity/truapi';
import { CallError, Result, type Codec } from '@parity/truapi/scale';

type WireCodec = {
  /** Decodes a frame's payload. Throws when the bytes are malformed. */
  dec: (bytes: Uint8Array) => unknown;
};

/** Wire-table keys and codec stems use different word orders, so this link is the one hand-written fact. */
type ChainLinkage = {
  wireTableKey: keyof typeof WIRE_TABLE;
  stem: string;
};

type Leg = 'request' | 'response' | 'start' | 'receive' | 'interrupt' | 'stop';

type FrameEntry = {
  tag: string;
  /** Tag-only when null, either on purpose or after a codegen-drift miss. */
  codec: WireCodec | null;
  /** The codec a local signing host decodes the leg with, which a paired phone would otherwise show the user. */
  walletCodec: WireCodec | null;
  /** Shown as its byte length only, when no codec decodes it. */
  redacted: boolean;
};

export type WireFrameId = {
  traitId: number;
  methodId: number;
  messageType: number;
};

type DescribeWireFrameParams = {
  /** Local mode only, where the panel stands in for the phone's request screen. */
  decodeWalletFrames?: boolean;
};

const CHAIN_LINKAGE: readonly ChainLinkage[] = [
  { wireTableKey: 'CHAIN_FOLLOW_HEAD_SUBSCRIBE', stem: 'HeadFollow' },
  { wireTableKey: 'CHAIN_GET_HEAD_HEADER', stem: 'HeadHeader' },
  { wireTableKey: 'CHAIN_GET_HEAD_BODY', stem: 'HeadBody' },
  { wireTableKey: 'CHAIN_GET_HEAD_STORAGE', stem: 'HeadStorage' },
  { wireTableKey: 'CHAIN_CALL_HEAD', stem: 'HeadCall' },
  { wireTableKey: 'CHAIN_UNPIN_HEAD', stem: 'HeadUnpin' },
  { wireTableKey: 'CHAIN_CONTINUE_HEAD', stem: 'HeadContinue' },
  { wireTableKey: 'CHAIN_STOP_HEAD_OPERATION', stem: 'HeadStopOperation' },
  { wireTableKey: 'CHAIN_GET_SPEC_GENESIS_HASH', stem: 'SpecGenesisHash' },
  { wireTableKey: 'CHAIN_GET_SPEC_CHAIN_NAME', stem: 'SpecChainName' },
  { wireTableKey: 'CHAIN_GET_SPEC_PROPERTIES', stem: 'SpecProperties' },
  { wireTableKey: 'CHAIN_GET_CHAIN_INFO', stem: 'Info' },
  {
    wireTableKey: 'CHAIN_BROADCAST_TRANSACTION',
    stem: 'TransactionBroadcast',
  },
  { wireTableKey: 'CHAIN_STOP_TRANSACTION', stem: 'TransactionStop' },
];

/** The requests a local signing host serves itself, which a paired phone would otherwise show the user. */
const WALLET_LINKAGE: readonly ChainLinkage[] = [
  { wireTableKey: 'SIGNING_SIGN_PAYLOAD', stem: 'SignPayload' },
  { wireTableKey: 'SIGNING_SIGN_PAYLOAD_WITH_LEGACY_ACCOUNT', stem: 'SignPayloadWithLegacyAccount' },
  { wireTableKey: 'SIGNING_SIGN_RAW', stem: 'SignRaw' },
  { wireTableKey: 'SIGNING_SIGN_RAW_WITH_LEGACY_ACCOUNT', stem: 'SignRawWithLegacyAccount' },
  { wireTableKey: 'SIGNING_CREATE_TRANSACTION', stem: 'CreateTransaction' },
  { wireTableKey: 'SIGNING_CREATE_TRANSACTION_WITH_LEGACY_ACCOUNT', stem: 'CreateTransactionWithLegacyAccount' },
  { wireTableKey: 'RESOURCE_ALLOCATION_REQUEST', stem: 'RequestResourceAllocation' },
];

const LEGS = {
  request: [
    [MESSAGE_TYPE_REQUEST, 'request'],
    [MESSAGE_TYPE_RESPONSE, 'response'],
  ],
  subscription: [
    [MESSAGE_TYPE_START, 'start'],
    [MESSAGE_TYPE_RECEIVE, 'receive'],
    [MESSAGE_TYPE_INTERRUPT, 'interrupt'],
    [MESSAGE_TYPE_STOP, 'stop'],
  ],
} satisfies Record<MethodIds['kind'], readonly (readonly [number, Leg])[]>;

// These families leave the tap as byte length only. Matching is by name, so a discriminant newer than
// the host's wire table falls back to raw bytes, an accepted skew.
const REDACTED_PREFIXES = ['signing', 'session', 'entropy', 'local_storage'];

const FRAMES = buildFrames();

/**
 * Returns the frame's tag and its decoded value, or its raw bytes when it has no codec or does not decode, or only its
 * length for a wallet frame the panel must not show.
 */
export function describeWireFrame(
  frame: WireFrameId,
  bytes: Uint8Array,
  { decodeWalletFrames = false }: DescribeWireFrameParams = {},
): { tag: string; value: unknown } {
  const wireId = getWireFrameKey(frame);
  const entry = FRAMES.get(wireId);
  if (entry === undefined) {
    const tag = `wire_${String(frame.traitId)}_${String(frame.methodId)}_${String(frame.messageType)}`;
    return { tag, value: { wireId, bytes } };
  }
  const undecoded = {
    tag: entry.tag,
    value: entry.redacted ? { redacted: true, byteLength: bytes.length } : { wireId, bytes },
  };
  const codec = (decodeWalletFrames ? entry.walletCodec : null) ?? entry.codec;
  if (codec === null) {
    return undecoded;
  }
  try {
    return { tag: entry.tag, value: codec.dec(bytes) };
  } catch {
    // A malformed frame shows undecoded rather than as garbage, never breaking the transport.
    return undecoded;
  }
}

/**
 * Every leg of every wire-table method, named from the table. A chain linkage row then retags its method's legs in their
 * chain's lane, and a wallet linkage row gives its method's legs their wallet codecs.
 */
function buildFrames(): Map<number, FrameEntry> {
  const frames = new Map<number, FrameEntry>();
  for (const [exportName, ids] of Object.entries(WIRE_TABLE)) {
    for (const [wireId, leg] of listLegs(ids)) {
      const tag = `${exportName.toLowerCase()}_${leg}`;
      const redacted = REDACTED_PREFIXES.some(prefix => tag.startsWith(prefix));
      frames.set(wireId, { tag, codec: null, walletCodec: null, redacted });
    }
  }
  for (const { wireTableKey, stem } of CHAIN_LINKAGE) {
    for (const [wireId, leg] of listLegs(WIRE_TABLE[wireTableKey])) {
      frames.set(wireId, {
        tag: `remote_chain_${toSnakeCase(stem)}_${leg}`,
        codec: resolveLegCodec(`VersionedRemoteChain${stem}`, leg),
        walletCodec: null,
        redacted: false,
      });
    }
  }
  for (const { wireTableKey, stem } of WALLET_LINKAGE) {
    for (const [wireId, leg] of listLegs(WIRE_TABLE[wireTableKey])) {
      const entry = frames.get(wireId);
      if (entry !== undefined) {
        frames.set(wireId, { ...entry, walletCodec: resolveLegCodec(`VersionedHost${stem}`, leg) });
      }
    }
  }
  return frames;
}

/** Each leg of a method, with the key its frames carry. */
function listLegs(ids: MethodIds): (readonly [number, Leg])[] {
  return LEGS[ids.kind].map(([messageType, leg]): readonly [number, Leg] => [
    getWireFrameKey({ traitId: ids.trait, methodId: ids.method, messageType }),
    leg,
  ]);
}

/** The number that keys a frame in the describer's table. */
function getWireFrameKey(frame: WireFrameId): number {
  return (frame.traitId << 16) | (frame.methodId << 8) | frame.messageType;
}

/** The codec of a method's `leg`, from the generated exports that start with `codecPrefix`. Null when there is none. */
function resolveLegCodec(codecPrefix: string, leg: Leg): WireCodec | null {
  switch (leg) {
    case 'request':
    case 'start':
      return resolveCodec(`${codecPrefix}Request`);
    case 'receive':
      return resolveCodec(`${codecPrefix}Item`);
    case 'response': {
      const okCodec = resolveCodec(`${codecPrefix}Response`);
      const errorCodec = resolveCodec(`${codecPrefix}Error`);
      // Must match the generated client's composition exactly, because a bare codec does not throw on real response
      // bytes and would quietly decode garbage instead of falling back to raw bytes.
      return okCodec !== null && errorCodec !== null ? Result(okCodec, CallError(errorCodec)) : null;
    }
    case 'interrupt':
    case 'stop':
      // Never decoded, but tagged, so every leg of a chain method carries its chain's tag.
      return null;
  }
}

/** Null on a renamed or removed export, so its leg is tag-only. */
function resolveCodec(exportName: string): Codec<unknown> | null {
  const candidate: unknown = Reflect.get(generated, exportName);
  return isCodec(candidate) ? candidate : null;
}

/**
 * Whether `value` is one of the generated module's codecs, which are arrays carrying their `dec`. The module's exports
 * are untyped by name, and only `dec` is ever called, so an export with a `dec` passes as a codec.
 */
function isCodec(value: unknown): value is Codec<unknown> {
  return typeof value === 'object' && value !== null && 'dec' in value && typeof value.dec === 'function';
}

function toSnakeCase(stem: string): string {
  return stem.replace(/(?!^)([A-Z])/g, '_$1').toLowerCase();
}
