// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Tags and decodes wire frames for the debug panel. The `remote_chain_*` tag names of chain frames are stable output.

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
import { isRecord } from '@dotli/shared';

type WireCodec = {
  /** Decodes a frame's payload. Throws when the bytes are malformed. */
  dec: (bytes: Uint8Array) => unknown;
};

/** Wire-table keys and codec stems use different word orders, so this link is the one hand-written fact. */
type ChainLinkage = {
  wireTableKey: keyof typeof WIRE_TABLE;
  stem: string;
};

/** One leg of a chain method, tagged in its chain's lane. */
type SetLegParams = {
  messageType: number;
  /** The leg's name, which ends its tag. */
  role: string;
  /** Null for a leg the panel shows as raw bytes. */
  codec: WireCodec | null;
};

type ChainEntry = {
  tag: string;
  /** Tag-only when null, either on purpose or after a codegen-drift miss. */
  codec: WireCodec | null;
};

type GenericEntry = {
  name: string;
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

const REQUEST_LEGS: readonly (readonly [number, string])[] = [
  [MESSAGE_TYPE_REQUEST, 'request'],
  [MESSAGE_TYPE_RESPONSE, 'response'],
];

const SUBSCRIPTION_LEGS: readonly (readonly [number, string])[] = [
  [MESSAGE_TYPE_START, 'start'],
  [MESSAGE_TYPE_RECEIVE, 'receive'],
  [MESSAGE_TYPE_INTERRUPT, 'interrupt'],
  [MESSAGE_TYPE_STOP, 'stop'],
];

// These families leave the tap as byte length only. Matching is by name, so a discriminant newer than
// the host's wire table falls back to raw bytes, an accepted skew.
const REDACTED_PREFIXES = ['signing', 'session', 'entropy', 'local_storage'];

let chainEntries: Map<number, ChainEntry> | null = null;
let genericNames: Map<number, GenericEntry> | null = null;
let walletCodecs: Map<number, WireCodec> | null = null;

/**
 * Returns the frame's tag and its decoded value, or its raw bytes when it has no codec or does not decode, or only its
 * length for a wallet frame the panel must not show. Never throws.
 */
export function describeWireFrame(
  frame: WireFrameId,
  bytes: Uint8Array,
  { decodeWalletFrames = false }: DescribeWireFrameParams = {},
): { tag: string; value: unknown } {
  chainEntries ??= buildChainEntries();
  genericNames ??= buildGenericNames();

  const wireId = getWireFrameKey(frame);
  const chain = chainEntries.get(wireId);
  if (chain !== undefined) {
    if (chain.codec === null) {
      return { tag: chain.tag, value: { wireId, bytes } };
    }
    try {
      return { tag: chain.tag, value: chain.codec.dec(bytes) };
    } catch {
      // A malformed frame degrades to raw bytes, never breaking the transport.
      return { tag: chain.tag, value: { wireId, bytes } };
    }
  }

  const generic = genericNames.get(wireId);
  if (generic === undefined) {
    const tag = `wire_${String(frame.traitId)}_${String(frame.methodId)}_${String(frame.messageType)}`;
    return { tag, value: { wireId, bytes } };
  }
  if (decodeWalletFrames) {
    walletCodecs ??= buildWalletCodecs();
    const codec = walletCodecs.get(wireId);
    if (codec !== undefined) {
      try {
        return { tag: generic.name, value: codec.dec(bytes) };
        // eslint-disable-next-line no-restricted-syntax -- a malformed frame falls through to the usual redaction.
      } catch {
        // Falls through to the redaction below rather than showing garbage.
      }
    }
  }
  if (generic.redacted) {
    return {
      tag: generic.name,
      value: { redacted: true, byteLength: bytes.length },
    };
  }
  return { tag: generic.name, value: { wireId, bytes } };
}

/** Returns the number that keys `frame` in the describer's tables. Never throws. */
export function getWireFrameKey(frame: WireFrameId): number {
  return (frame.traitId << 16) | (frame.methodId << 8) | frame.messageType;
}

/** Returns the frame id of a method's `messageType` leg. Never throws. */
export function getWireFrameId(ids: MethodIds, messageType: number): WireFrameId {
  return { traitId: ids.trait, methodId: ids.method, messageType };
}

/**
 * Must match the generated client's composition exactly, because a bare codec does not throw on real
 * response bytes and would quietly decode garbage instead of falling back to raw bytes.
 */
function createResponseCodec<Value, Failure>(okCodec: Codec<Value>, errorCodec: Codec<Failure>): WireCodec {
  return Result(okCodec, CallError(errorCodec));
}

function toSnakeCase(stem: string): string {
  return stem.replace(/(?!^)([A-Z])/g, '_$1').toLowerCase();
}

/** Undefined on a renamed or removed export, so the caller falls back to a tag-only entry. */
function resolveCodec(exportName: string): Codec<unknown> | undefined {
  const generatedExports: unknown = generated;
  if (!isRecord(generatedExports)) {
    return undefined;
  }
  const candidate = generatedExports[exportName];
  return isCodec(candidate) ? candidate : undefined;
}

/**
 * Whether `value` is one of the generated module's codecs, which are arrays carrying their `dec`. The module's exports
 * are untyped by name, and only `dec` is ever called, so an export with a `dec` passes as a codec.
 */
function isCodec(value: unknown): value is Codec<unknown> {
  return typeof value === 'object' && value !== null && 'dec' in value && typeof value.dec === 'function';
}

function getLegs(ids: MethodIds): readonly (readonly [number, string])[] {
  return ids.kind === 'subscription' ? SUBSCRIPTION_LEGS : REQUEST_LEGS;
}

function isMethodIds(value: unknown): value is MethodIds {
  return isRecord(value) && typeof value['trait'] === 'number' && typeof value['method'] === 'number';
}

function buildChainEntries(): Map<number, ChainEntry> {
  const entries = new Map<number, ChainEntry>();

  for (const { wireTableKey, stem } of CHAIN_LINKAGE) {
    const ids: MethodIds = WIRE_TABLE[wireTableKey];
    const tagBase = `remote_chain_${toSnakeCase(stem)}`;

    function setLeg({ messageType, role, codec }: SetLegParams): void {
      entries.set(getWireFrameKey(getWireFrameId(ids, messageType)), {
        tag: `${tagBase}_${role}`,
        codec,
      });
    }

    if (ids.kind === 'subscription') {
      setLeg({
        messageType: MESSAGE_TYPE_START,
        role: 'start',
        codec: resolveCodec(`VersionedRemoteChain${stem}Request`) ?? null,
      });
      setLeg({
        messageType: MESSAGE_TYPE_RECEIVE,
        role: 'receive',
        codec: resolveCodec(`VersionedRemoteChain${stem}Item`) ?? null,
      });
      // Never decoded, but tagged, so every leg of a chain method carries its chain's tag.
      setLeg({ messageType: MESSAGE_TYPE_INTERRUPT, role: 'interrupt', codec: null });
      setLeg({ messageType: MESSAGE_TYPE_STOP, role: 'stop', codec: null });
      continue;
    }

    setLeg({
      messageType: MESSAGE_TYPE_REQUEST,
      role: 'request',
      codec: resolveCodec(`VersionedRemoteChain${stem}Request`) ?? null,
    });
    const okCodec = resolveCodec(`VersionedRemoteChain${stem}Response`);
    const errorCodec = resolveCodec(`VersionedRemoteChain${stem}Error`);
    setLeg({
      messageType: MESSAGE_TYPE_RESPONSE,
      role: 'response',
      codec: okCodec !== undefined && errorCodec !== undefined ? createResponseCodec(okCodec, errorCodec) : null,
    });
  }

  return entries;
}

function buildWalletCodecs(): Map<number, WireCodec> {
  const codecs = new Map<number, WireCodec>();
  for (const { wireTableKey, stem } of WALLET_LINKAGE) {
    const ids: MethodIds = WIRE_TABLE[wireTableKey];
    const requestCodec = resolveCodec(`VersionedHost${stem}Request`);
    const okCodec = resolveCodec(`VersionedHost${stem}Response`);
    const errorCodec = resolveCodec(`VersionedHost${stem}Error`);
    if (requestCodec !== undefined) {
      codecs.set(getWireFrameKey(getWireFrameId(ids, MESSAGE_TYPE_REQUEST)), requestCodec);
    }
    if (okCodec !== undefined && errorCodec !== undefined) {
      codecs.set(getWireFrameKey(getWireFrameId(ids, MESSAGE_TYPE_RESPONSE)), createResponseCodec(okCodec, errorCodec));
    }
  }
  return codecs;
}

function buildGenericNames(): Map<number, GenericEntry> {
  const names = new Map<number, GenericEntry>();
  for (const [exportName, ids] of Object.entries(WIRE_TABLE)) {
    if (!isMethodIds(ids)) {
      continue;
    }
    for (const [messageType, role] of getLegs(ids)) {
      const name = `${exportName.toLowerCase()}_${role}`;
      const redacted = REDACTED_PREFIXES.some(prefix => name.startsWith(prefix));
      names.set(getWireFrameKey(getWireFrameId(ids, messageType)), {
        name,
        redacted,
      });
    }
  }
  return names;
}
