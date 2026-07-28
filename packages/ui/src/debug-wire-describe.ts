// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Debug-panel frame describer.
//
// Maps a wire discriminant to a stable method tag and, for registered
// families, decodes the SCALE payload so the panel's semantic layer
// (`@dotli/truapi-debug` chain-decode) receives the tag vocabulary and
// value shapes it expects. Chain-family frames keep the pre-port
// `remote_chain_*` tag names on purpose: the panel's swimlane and
// annotation logic keys on them.
//
// The chain-family registry below is deliberately minimal. `@parity/truapi`
// codegen names its chain wire-table entries and its generated codec exports
// on two different (correct, but non-matching) word orders — e.g. the
// wire-table key is `CHAIN_GET_HEAD_HEADER` but the codec stem is
// `HeadHeader` — so the linkage between a wire-table entry and its codec
// family can't be derived from either name alone. `CHAIN_LINKAGE` below is
// the one hand-maintained table that bridges them; everything else (legacy
// tag strings, which of the four call/subscription shapes applies, which
// generated export names to resolve, and which methods have a void Ok
// response) is derived mechanically from it and from the installed
// `@parity/truapi`'s actual exports, so a codegen rename or a new chain
// method either "just works" or fails loudly in the drift-guard test
// instead of silently mis-decoding.

import * as WIRE_TABLE from "@parity/truapi/wire-table";
import * as generated from "@parity/truapi";
import {
  CallError,
  indexedTaggedUnion,
  Result,
  _void,
  type Codec,
} from "@parity/truapi/scale";

interface WireCodec {
  dec: (bytes: Uint8Array) => unknown;
}

/**
 * Builds the codec for a `chainHead`/`chainSpec`/`transaction` *response*
 * discriminant. The generated client (`@parity/truapi/dist/generated/client.js`)
 * composes every response as an indexed `V1` envelope around
 * `Result(<bare response struct>, CallError(<versioned error>))` — never a
 * bare `Versioned*Response` struct. Mirroring that composition here (rather
 * than decoding with the bare struct codec) matters because the bare codec
 * does not throw on real response bytes: it silently produces
 * `{"tag":"V1","value":{}}`-shaped garbage instead of surfacing a decode
 * failure, which would defeat the raw-bytes fallback in `describeWireFrame`.
 */
function responseCodec<T, E>(ok: Codec<T>, err: Codec<E>): WireCodec {
  return indexedTaggedUnion({ V1: [0, Result(ok, CallError(err))] });
}

/**
 * Links a chain wire-table entry to the generated codec family that
 * describes its payloads. The wire-table key and the codec `stem` are two
 * independently-chosen names for the same method (word order differs), so
 * this row can't be derived — it's the minimum hand-written fact. Everything
 * derived from a row (legacy tag, shape, export names to resolve) is
 * verified against the installed `@parity/truapi` by the drift-guard test.
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
  {
    wireTableKey: "CHAIN_BROADCAST_TRANSACTION",
    stem: "TransactionBroadcast",
  },
  { wireTableKey: "CHAIN_STOP_TRANSACTION", stem: "TransactionStop" },
];

/**
 * Chain methods whose Ok response is `_void` (no bare `RemoteChain<Stem>Response`
 * runtime export exists to resolve). Verified against `@parity/truapi`'s
 * generated client, which decodes each of these with
 * `Result(S._void, CallError(...))`. This has to stay an explicit set rather
 * than a `resolveCodec(...) ?? _void` fallback: a renamed export would then
 * silently decode with the wrong (void) codec instead of degrading to the
 * raw-bytes fallback that a genuine lookup miss gets everywhere else.
 */
const VOID_RESPONSE_STEMS: ReadonlySet<string> = new Set([
  "HeadUnpin",
  "HeadContinue",
  "HeadStopOperation",
  "TransactionStop",
]);

/** `Codec<void>` widened so it type-checks alongside dynamically resolved codecs. */
const VOID_CODEC = _void as unknown as Codec<unknown>;

/** PascalCase codec stem → the legacy tag's snake_case segment, e.g. `HeadStopOperation` → `head_stop_operation`. */
function snakeCase(stem: string): string {
  let out = "";
  for (let i = 0; i < stem.length; i += 1) {
    const char = stem[i];
    const isUpper = char >= "A" && char <= "Z";
    out += isUpper
      ? i === 0
        ? char.toLowerCase()
        : `_${char.toLowerCase()}`
      : char;
  }
  return out;
}

/**
 * Resolves a generated codec export by name from the installed
 * `@parity/truapi`, validating it looks like a codec before use. Returns
 * `undefined` on a miss (renamed/removed export) rather than throwing, so
 * the caller can fall back to a tag-only, raw-bytes entry instead of
 * decoding with a wrong or absent codec.
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
  /** `null` means tag-only: no codec (missing on purpose, or a codegen-drift miss). */
  codec: WireCodec | null;
}

interface SubscriptionRoles {
  start: number;
  stop: number;
  interrupt: number;
  receive: number;
}

interface CallRoles {
  request: number;
  response: number;
}

function isSubscriptionRoles(
  roles: SubscriptionRoles | CallRoles,
): roles is SubscriptionRoles {
  return "start" in roles;
}

/**
 * Builds every chain-family discriminant's `{ tag, codec }` entry from
 * `CHAIN_LINKAGE`, resolving codec exports at runtime and degrading to
 * tag-only (raw bytes) wherever a lookup misses. Folds in the
 * `chainHead_follow` subscription's `stop`/`interrupt` control frames, which
 * never had payloads worth decoding — the swimlane layout
 * (`timeline-layout.ts`) assigns lanes by `tag.startsWith("remote_chain_")`
 * plus a requestId→genesis map, so these still need the legacy
 * `remote_chain_*` tag prefix to land in their chain's lane instead of
 * "other".
 */
function buildChainEntries(): Map<number, ChainEntry> {
  const entries = new Map<number, ChainEntry>();

  for (const { wireTableKey, stem } of CHAIN_LINKAGE) {
    const roles = WIRE_TABLE[wireTableKey] as unknown as
      | SubscriptionRoles
      | CallRoles;
    const tagBase = `remote_chain_${snakeCase(stem)}`;

    if (isSubscriptionRoles(roles)) {
      const startCodec = resolveCodec(`VersionedRemoteChain${stem}Request`);
      const receiveCodec = resolveCodec(`VersionedRemoteChain${stem}Item`);
      entries.set(roles.start, {
        tag: `${tagBase}_start`,
        codec: startCodec ?? null,
      });
      entries.set(roles.receive, {
        tag: `${tagBase}_receive`,
        codec: receiveCodec ?? null,
      });
      // Control frames: legacy tag for swimlane routing, never decoded.
      entries.set(roles.stop, { tag: `${tagBase}_stop`, codec: null });
      entries.set(roles.interrupt, {
        tag: `${tagBase}_interrupt`,
        codec: null,
      });
      continue;
    }

    const requestCodec = resolveCodec(`VersionedRemoteChain${stem}Request`);
    entries.set(roles.request, {
      tag: `${tagBase}_request`,
      codec: requestCodec ?? null,
    });

    const okCodec = VOID_RESPONSE_STEMS.has(stem)
      ? VOID_CODEC
      : resolveCodec(`RemoteChain${stem}Response`);
    const errCodec = resolveCodec(`VersionedRemoteChain${stem}Error`);
    const responseWireCodec =
      okCodec !== undefined && errCodec !== undefined
        ? responseCodec(okCodec, errCodec)
        : null;
    entries.set(roles.response, {
      tag: `${tagBase}_response`,
      codec: responseWireCodec,
    });
  }

  return entries;
}

// Decoded contents of these families never leave the tap — not even the
// raw bytes the panel used to receive. Byte length only.
// Redaction matches by the mechanical name derived from this installed
// `@parity/truapi`'s wire table. A discriminant from a newer SDK than the
// host's wire table knows about has no name to match against, so it can't
// be redacted here and falls back to raw bytes via `genericNames` — an
// accepted skew window until the host's `@parity/truapi` dependency catches up.
const REDACTED_PREFIXES = ["signing", "session", "entropy", "local_storage"];

/** Every other discriminant gets `<lowercased export>_<role>` from the wire table. */
function buildGenericNames(): Map<number, string> {
  const names = new Map<number, string>();
  for (const [exportName, roles] of Object.entries(WIRE_TABLE)) {
    if (typeof roles !== "object") {
      continue;
    }
    for (const [role, id] of Object.entries(roles)) {
      if (typeof id === "number") {
        names.set(id, `${exportName.toLowerCase()}_${role}`);
      }
    }
  }
  return names;
}

let chainEntries: Map<number, ChainEntry> | null = null;
let genericNames: Map<number, string> | null = null;

export function describeWireFrame(
  wireId: number,
  bytes: Uint8Array,
): { tag: string; value: unknown } {
  chainEntries ??= buildChainEntries();
  genericNames ??= buildGenericNames();

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

  const name = genericNames.get(wireId);
  if (name === undefined) {
    return { tag: `wire_${String(wireId)}`, value: { wireId, bytes } };
  }
  if (REDACTED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return { tag: name, value: { redacted: true, byteLength: bytes.length } };
  }
  return { tag: name, value: { wireId, bytes } };
}

// Exposed for the drift-guard test only: it needs to walk the linkage table
// and independently re-derive/verify tags and codec resolution against the
// installed `@parity/truapi`, without duplicating this module's internals.
export const __testing = {
  CHAIN_LINKAGE,
  VOID_RESPONSE_STEMS,
  snakeCase,
  resolveCodec,
  buildChainEntries,
};
