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
 * Builds the codec for a chain response discriminant. The generated client
 * wraps every response in a `V1` envelope around
 * `Result(<bare response struct>, CallError(<versioned error>))`, never a
 * bare `Versioned*Response`. The composition has to match because the bare
 * codec doesn't throw on real response bytes. It quietly decodes garbage,
 * which would defeat the raw-bytes fallback in `describeWireFrame`.
 */
function responseCodec<T, E>(ok: Codec<T>, err: Codec<E>): WireCodec {
  return indexedTaggedUnion({ V1: [0, Result(ok, CallError(err))] });
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
  {
    wireTableKey: "CHAIN_BROADCAST_TRANSACTION",
    stem: "TransactionBroadcast",
  },
  { wireTableKey: "CHAIN_STOP_TRANSACTION", stem: "TransactionStop" },
];

/**
 * Chain methods whose Ok response is `_void`. These have no bare
 * `RemoteChain<Stem>Response` export to resolve, and the generated client
 * decodes them with `Result(_void, CallError(...))`. Kept as an explicit
 * set on purpose. With a `?? _void` fallback a renamed export would
 * silently decode with the wrong codec instead of degrading to raw bytes.
 */
const VOID_RESPONSE_STEMS: ReadonlySet<string> = new Set([
  "HeadUnpin",
  "HeadContinue",
  "HeadStopOperation",
  "TransactionStop",
]);

/** `Codec<void>` widened so it type-checks alongside dynamically resolved codecs. */
const VOID_CODEC = _void as unknown as Codec<unknown>;

/** Turns a codec stem into its tag segment, e.g. `HeadStopOperation` into `head_stop_operation`. */
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
 * Builds every chain discriminant's `{ tag, codec }` entry from
 * `CHAIN_LINKAGE`, degrading to tag-only wherever a codec lookup misses.
 * The follow subscription's `stop`/`interrupt` control frames carry nothing
 * worth decoding, but the swimlane layout assigns lanes by the
 * `remote_chain_` tag prefix, so they still get the legacy tag to land in
 * their chain's lane instead of "other".
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

// These families never leave the tap, not even as raw bytes. Byte length
// only. Matching is by name, so a discriminant from an SDK newer than the
// host's wire table has no name to match and falls back to raw bytes. That
// skew window is accepted until the host's truapi dependency catches up.
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

// Exposed for the drift-guard test, which walks the linkage table and
// verifies tags and codec resolution against the installed `@parity/truapi`.
export const __testing = {
  CHAIN_LINKAGE,
  VOID_RESPONSE_STEMS,
  snakeCase,
  resolveCodec,
  buildChainEntries,
};
