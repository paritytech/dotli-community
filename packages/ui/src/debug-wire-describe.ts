// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Tags and decodes wire frames for the debug panel. Chain frames keep the `remote_chain_*` tag names
// because the panel's swimlane and annotation logic keys on them.

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

interface WireCodec {
  dec: (bytes: Uint8Array) => unknown;
}

/**
 * Must match the generated client's composition exactly, because a bare codec does not throw on real
 * response bytes and would quietly decode garbage instead of falling back to raw bytes.
 */
function responseCodec<T, E>(ok: Codec<T>, err: Codec<E>): WireCodec {
  return Result(ok, CallError(err));
}

/**
 * Wire-table keys and codec stems use different word orders, so this link is the one hand-written fact.
 * The drift-guard test checks everything derived from it against the installed `@parity/truapi`.
 */
interface ChainLinkage {
  wireTableKey: keyof typeof WIRE_TABLE;
  stem: string;
}

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

function snakeCase(stem: string): string {
  return stem.replace(/(?!^)([A-Z])/g, '_$1').toLowerCase();
}

/** Undefined on a renamed or removed export, so the caller falls back to a tag-only entry. */
function resolveCodec(exportName: string): Codec<unknown> | undefined {
  const candidate = (generated as Record<string, unknown>)[exportName];
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as { dec?: unknown }).dec === 'function'
  ) {
    return candidate as Codec<unknown>;
  }
  return undefined;
}

interface ChainEntry {
  tag: string;
  /** Tag-only when null, either on purpose or after a codegen-drift miss. */
  codec: WireCodec | null;
}

export interface WireFrameId {
  traitId: number;
  methodId: number;
  messageType: number;
}

export function wireFrameKey(frame: WireFrameId): number {
  return (frame.traitId << 16) | (frame.methodId << 8) | frame.messageType;
}

export function wireFrameId(ids: MethodIds, messageType: number): WireFrameId {
  return { traitId: ids.trait, methodId: ids.method, messageType };
}

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

function legsOf(ids: MethodIds): readonly (readonly [number, string])[] {
  return ids.kind === 'subscription' ? SUBSCRIPTION_LEGS : REQUEST_LEGS;
}

function isMethodIds(value: unknown): value is MethodIds {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MethodIds).trait === 'number' &&
    typeof (value as MethodIds).method === 'number'
  );
}

function buildChainEntries(): Map<number, ChainEntry> {
  const entries = new Map<number, ChainEntry>();

  for (const { wireTableKey, stem } of CHAIN_LINKAGE) {
    const ids = WIRE_TABLE[wireTableKey] as unknown as MethodIds;
    const tagBase = `remote_chain_${snakeCase(stem)}`;
    const set = (messageType: number, role: string, codec: WireCodec | null): void => {
      entries.set(wireFrameKey(wireFrameId(ids, messageType)), {
        tag: `${tagBase}_${role}`,
        codec,
      });
    };

    if (ids.kind === 'subscription') {
      set(MESSAGE_TYPE_START, 'start', resolveCodec(`VersionedRemoteChain${stem}Request`) ?? null);
      set(MESSAGE_TYPE_RECEIVE, 'receive', resolveCodec(`VersionedRemoteChain${stem}Item`) ?? null);
      // Never decoded, but tagged so the swimlane puts them in their chain's lane.
      set(MESSAGE_TYPE_INTERRUPT, 'interrupt', null);
      set(MESSAGE_TYPE_STOP, 'stop', null);
      continue;
    }

    set(MESSAGE_TYPE_REQUEST, 'request', resolveCodec(`VersionedRemoteChain${stem}Request`) ?? null);
    const okCodec = resolveCodec(`VersionedRemoteChain${stem}Response`);
    const errCodec = resolveCodec(`VersionedRemoteChain${stem}Error`);
    set(
      MESSAGE_TYPE_RESPONSE,
      'response',
      okCodec !== undefined && errCodec !== undefined ? responseCodec(okCodec, errCodec) : null,
    );
  }

  return entries;
}

// These families leave the tap as byte length only. Matching is by name, so a discriminant newer than
// the host's wire table falls back to raw bytes, an accepted skew.
const REDACTED_PREFIXES = ['signing', 'session', 'entropy', 'local_storage'];

interface GenericEntry {
  name: string;
  redacted: boolean;
}

function buildGenericNames(): Map<number, GenericEntry> {
  const names = new Map<number, GenericEntry>();
  for (const [exportName, ids] of Object.entries(WIRE_TABLE)) {
    if (!isMethodIds(ids)) {
      continue;
    }
    for (const [messageType, role] of legsOf(ids)) {
      const name = `${exportName.toLowerCase()}_${role}`;
      const redacted = REDACTED_PREFIXES.some(prefix => name.startsWith(prefix));
      names.set(wireFrameKey(wireFrameId(ids, messageType)), {
        name,
        redacted,
      });
    }
  }
  return names;
}

let chainEntries: Map<number, ChainEntry> | null = null;
let genericNames: Map<number, GenericEntry> | null = null;

export function describeWireFrame(frame: WireFrameId, bytes: Uint8Array): { tag: string; value: unknown } {
  chainEntries ??= buildChainEntries();
  genericNames ??= buildGenericNames();

  const wireId = wireFrameKey(frame);
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
  if (generic.redacted) {
    return {
      tag: generic.name,
      value: { redacted: true, byteLength: bytes.length },
    };
  }
  return { tag: generic.name, value: { wireId, bytes } };
}

// For the drift-guard test.
export const __testing = {
  CHAIN_LINKAGE,
  snakeCase,
  resolveCodec,
  buildChainEntries,
  legsOf,
};
