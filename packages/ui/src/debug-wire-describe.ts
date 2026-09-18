// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Debug-panel frame describer.
//
// Maps a wire discriminant to a stable method tag and, for registered
// families, decodes the SCALE payload so the panel's semantic layer
// (`@dotli/truapi-debug` chain-decode) gets the tags and value shapes it
// expects. Chain frames keep the pre-port `remote_chain_*` tag names on
// purpose, the panel's swimlane and annotation logic keys on them.
//
// The chain registry below is deliberately small. Codegen names its
// wire-table entries and its codec exports with different word orders
// (wire-table key `CHAIN_GET_HEAD_HEADER`, codec stem `HeadHeader`), so the
// link between them can't be derived from either name. `CHAIN_LINKAGE` is
// that one hand-maintained table. Everything else (tags, call/subscription
// shape, export names, void responses) is derived from it and from the
// installed `@parity/truapi`, so a codegen rename or a new chain method
// either just works or fails loudly in the drift-guard test instead of
// silently mis-decoding.

import * as WIRE_TABLE from "@parity/truapi/wire-table";
import * as generated from "@parity/truapi";
import {
  MESSAGE_TYPE_INTERRUPT,
  MESSAGE_TYPE_RECEIVE,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  MESSAGE_TYPE_START,
  MESSAGE_TYPE_STOP,
  type MethodIds,
} from "@parity/truapi";
import { CallError, Result, type Codec } from "@parity/truapi/scale";

interface WireCodec {
  dec: (bytes: Uint8Array) => unknown;
}

/**
 * Builds the codec for a chain response leg. Codec 2 puts the `Result`
 * outside and each leg's own version wrapper inside:
 * `Result(Versioned<Stem>Response, CallError(Versioned<Stem>Error))`, exactly
 * as the generated client decodes it. The composition has to match because a
 * bare codec doesn't throw on real response bytes. It quietly decodes garbage,
 * which would defeat the raw-bytes fallback in `describeWireFrame`.
 */
function responseCodec<T, E>(ok: Codec<T>, err: Codec<E>): WireCodec {
  return Result(ok, CallError(err));
}

/**
 * Links a chain wire-table entry to its generated codec family. The two
 * names use different word orders, so this row can't be derived and is the
 * only hand-written fact. Everything derived from it is checked against the
 * installed `@parity/truapi` by the drift-guard test.
 */
interface ChainLinkage {
  wireTableKey: keyof typeof WIRE_TABLE;
  stem: string;
}

const CHAIN_LINKAGE: readonly ChainLinkage[] = [
  { wireTableKey: "CHAIN_FOLLOW_HEAD_SUBSCRIBE", stem: "HeadFollow" },
  { wireTableKey: "CHAIN_GET_HEAD_HEADER", stem: "HeadHeader" },
  { wireTableKey: "CHAIN_GET_HEAD_BODY", stem: "HeadBody" },
  { wireTableKey: "CHAIN_GET_HEAD_STORAGE", stem: "HeadStorage" },
  { wireTableKey: "CHAIN_CALL_HEAD", stem: "HeadCall" },
  { wireTableKey: "CHAIN_UNPIN_HEAD", stem: "HeadUnpin" },
  { wireTableKey: "CHAIN_CONTINUE_HEAD", stem: "HeadContinue" },
  { wireTableKey: "CHAIN_STOP_HEAD_OPERATION", stem: "HeadStopOperation" },
  { wireTableKey: "CHAIN_GET_SPEC_GENESIS_HASH", stem: "SpecGenesisHash" },
  { wireTableKey: "CHAIN_GET_SPEC_CHAIN_NAME", stem: "SpecChainName" },
  { wireTableKey: "CHAIN_GET_SPEC_PROPERTIES", stem: "SpecProperties" },
  { wireTableKey: "CHAIN_GET_CHAIN_INFO", stem: "Info" },
  {
    wireTableKey: "CHAIN_BROADCAST_TRANSACTION",
    stem: "TransactionBroadcast",
  },
  { wireTableKey: "CHAIN_STOP_TRANSACTION", stem: "TransactionStop" },
];

/** Turns a codec stem into its tag segment, e.g. `HeadStopOperation` into `head_stop_operation`. */
function snakeCase(stem: string): string {
  return stem.replace(/(?!^)([A-Z])/g, "_$1").toLowerCase();
}

/**
 * Looks up a generated codec export by name and checks it looks like a
 * codec. Returns `undefined` on a miss (renamed or removed export) so the
 * caller falls back to a tag-only raw-bytes entry.
 */
function resolveCodec(exportName: string): Codec<unknown> | undefined {
  const candidate = (generated as Record<string, unknown>)[exportName];
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { dec?: unknown }).dec === "function"
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

/** The (trait, method, messageType) triple that identifies one wire leg. */
export interface WireFrameId {
  traitId: number;
  methodId: number;
  messageType: number;
}

/** Packs a frame's triple into one stable number for map keys and raw dumps. */
export function wireFrameKey(frame: WireFrameId): number {
  return (frame.traitId << 16) | (frame.methodId << 8) | frame.messageType;
}

/** The frame id of one leg of `ids`, for callers holding a wire-table entry. */
export function wireFrameId(ids: MethodIds, messageType: number): WireFrameId {
  return { traitId: ids.trait, methodId: ids.method, messageType };
}

const REQUEST_LEGS: readonly (readonly [number, string])[] = [
  [MESSAGE_TYPE_REQUEST, "request"],
  [MESSAGE_TYPE_RESPONSE, "response"],
];

const SUBSCRIPTION_LEGS: readonly (readonly [number, string])[] = [
  [MESSAGE_TYPE_START, "start"],
  [MESSAGE_TYPE_RECEIVE, "receive"],
  [MESSAGE_TYPE_INTERRUPT, "interrupt"],
  [MESSAGE_TYPE_STOP, "stop"],
];

/** The legs a method's `kind` implies, as `[messageType, role]` pairs. */
function legsOf(ids: MethodIds): readonly (readonly [number, string])[] {
  return ids.kind === "subscription" ? SUBSCRIPTION_LEGS : REQUEST_LEGS;
}

function isMethodIds(value: unknown): value is MethodIds {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as MethodIds).trait === "number" &&
    typeof (value as MethodIds).method === "number"
  );
}

/**
 * Builds every chain leg's `{ tag, codec }` entry from `CHAIN_LINKAGE`,
 * degrading to tag-only wherever a codec lookup misses. The follow
 * subscription's `stop`/`interrupt` control frames carry nothing worth
 * decoding, but the swimlane layout assigns lanes by the `remote_chain_` tag
 * prefix, so they still get the legacy tag to land in their chain's lane
 * instead of "other".
 */
function buildChainEntries(): Map<number, ChainEntry> {
  const entries = new Map<number, ChainEntry>();

  for (const { wireTableKey, stem } of CHAIN_LINKAGE) {
    const ids = WIRE_TABLE[wireTableKey] as unknown as MethodIds;
    const tagBase = `remote_chain_${snakeCase(stem)}`;
    const set = (
      messageType: number,
      role: string,
      codec: WireCodec | null,
    ): void => {
      entries.set(wireFrameKey(wireFrameId(ids, messageType)), {
        tag: `${tagBase}_${role}`,
        codec,
      });
    };

    if (ids.kind === "subscription") {
      set(
        MESSAGE_TYPE_START,
        "start",
        resolveCodec(`VersionedRemoteChain${stem}Request`) ?? null,
      );
      set(
        MESSAGE_TYPE_RECEIVE,
        "receive",
        resolveCodec(`VersionedRemoteChain${stem}Item`) ?? null,
      );
      // Control frames: legacy tag for swimlane routing, never decoded.
      set(MESSAGE_TYPE_INTERRUPT, "interrupt", null);
      set(MESSAGE_TYPE_STOP, "stop", null);
      continue;
    }

    set(
      MESSAGE_TYPE_REQUEST,
      "request",
      resolveCodec(`VersionedRemoteChain${stem}Request`) ?? null,
    );
    const okCodec = resolveCodec(`VersionedRemoteChain${stem}Response`);
    const errCodec = resolveCodec(`VersionedRemoteChain${stem}Error`);
    set(
      MESSAGE_TYPE_RESPONSE,
      "response",
      okCodec !== undefined && errCodec !== undefined
        ? responseCodec(okCodec, errCodec)
        : null,
    );
  }

  return entries;
}

// These families never leave the tap, not even as raw bytes. Byte length
// only. Matching is by name, so a discriminant from an SDK newer than the
// host's wire table has no name to match and falls back to raw bytes. That
// skew window is accepted until the host's truapi dependency catches up.
const REDACTED_PREFIXES = ["signing", "session", "entropy", "local_storage"];

interface GenericEntry {
  name: string;
  redacted: boolean;
}

/**
 * Every other leg gets `<lowercased export>_<role>` from the wire table,
 * with the roles implied by the entry's `kind`. The redaction flag is
 * precomputed here so the per-frame path does a single map lookup.
 */
function buildGenericNames(): Map<number, GenericEntry> {
  const names = new Map<number, GenericEntry>();
  for (const [exportName, ids] of Object.entries(WIRE_TABLE)) {
    if (!isMethodIds(ids)) {
      continue;
    }
    for (const [messageType, role] of legsOf(ids)) {
      const name = `${exportName.toLowerCase()}_${role}`;
      const redacted = REDACTED_PREFIXES.some((prefix) =>
        name.startsWith(prefix),
      );
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

export function describeWireFrame(
  frame: WireFrameId,
  bytes: Uint8Array,
): { tag: string; value: unknown } {
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
      // A malformed frame must degrade to raw bytes in the debugger, never
      // break the transport.
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

// Exposed for the drift-guard test, which walks the linkage table and
// verifies tags and codec resolution against the installed `@parity/truapi`.
export const __testing = {
  CHAIN_LINKAGE,
  snakeCase,
  resolveCodec,
  buildChainEntries,
  legsOf,
};
