/** SCALE codec primitives used by the generated client.
 *
 * Thin wrapper over `scale-ts`: re-exports its primitives and combinators,
 * plus the Polkadot-flavour helpers it does not ship (hex-encoded bytes,
 * lazy recursive codecs, and `V<N>`-indexed tagged unions).
 */
import { Bytes, Enum, Struct, createCodec, createDecoder, enhanceCodec, str, u8, _void, } from "scale-ts";
import { bytesToHex as encodeHex, hexToBytes as decodeHex, } from "@noble/hashes/utils.js";
export { Bytes, Enum, Option, Result, Struct, Tuple, Vector, _void, bool, compact, i8, i16, i32, i64, i128, str, u8, u16, u32, u64, u128, } from "scale-ts";
/**
 * Substrate `OptionBool`: a one-byte `Option<bool>`.
 *
 * Canonical SCALE encoding (matches `parity_scale_codec::OptionBool`):
 * `undefined` → `0`, `true` → `1`, `false` → `2`.
 */
export const OptionBool = enhanceCodec(u8, (value) => (value === undefined ? 0 : value ? 1 : 2), (byte) => {
    switch (byte) {
        case 0:
            return undefined;
        case 1:
            return true;
        case 2:
            return false;
        default:
            throw new Error(`Unknown OptionBool byte: ${byte}. Expected 0, 1, or 2.`);
    }
});
/** Assert that a string is a valid hex string (`0x...`). */
export function toHexString(value) {
    if (!value.startsWith("0x")) {
        throw new Error(`Expected hex string starting with 0x, got: ${value.slice(0, 20)}`);
    }
    return value;
}
/** Encode a byte array as a lower-case hex string with a `0x` prefix. */
export function bytesToHex(bytes) {
    return `0x${encodeHex(bytes)}`;
}
/** Decode a hex string into a byte array. Tolerates a missing `0x` prefix. */
export function hexToBytes(hex) {
    return decodeHex(hex.startsWith("0x") ? hex.slice(2) : hex);
}
/**
 * SCALE codec for hex-encoded byte strings.
 *
 * Encode accepts a `0x`-prefixed hex string and emits SCALE bytes; decode
 * returns the bytes as a hex string. Pass `length` for fixed-size byte arrays
 * (`[u8; N]`); omit it for variable-length byte vectors (`Vec<u8>`).
 */
export function Hex(length) {
    return enhanceCodec(Bytes(length), hexToBytes, bytesToHex);
}
/**
 * Same wire format as `scale-ts`'s `Enum`, but exposes `value` as optional in
 * the public TS type when the variant codec is `Codec<undefined>`. Lets unit
 * variants of mixed enums round-trip as `{ tag: "X" }` (no `value` key).
 */
export function TaggedUnion(inner) {
    return Enum(inner);
}
/** SCALE codec for Rust's derived `CallError<D>` enum. */
export function CallError(domain) {
    return TaggedUnion({
        Domain: domain,
        Denied: _void,
        Unsupported: _void,
        MalformedFrame: Struct({ reason: str }),
        HostFailure: Struct({ reason: str }),
    });
}
/**
 * Enum without payloads — maps string labels to SCALE discriminant bytes.
 *
 * `scale-ts` models `Enum({ Foo: _void, Bar: _void })` as tagged objects. For
 * user-facing TrUAPI enums with only unit variants, we keep the public TS shape
 * as a plain string union instead.
 */
export function Status(...variants) {
    return enhanceCodec(u8, (value) => {
        const index = variants.indexOf(value);
        if (index === -1) {
            throw new Error(`Unknown status value: ${String(value)}`);
        }
        return index;
    }, (index) => {
        const value = variants[index];
        if (value === undefined) {
            throw new Error(`Unknown status index: ${index}`);
        }
        return value;
    });
}
/**
 * Defers codec construction until first use so recursive generated codecs can
 * reference each other safely.
 */
export function lazy(factory) {
    let resolved;
    const get = () => (resolved ??= factory());
    return createCodec((value) => get().enc(value), (input) => get().dec(input));
}
/**
 * Builds a tagged union codec with explicit SCALE discriminants.
 *
 * `scale-ts` assigns enum indexes by object key order. TrUAPI versioned enums pin
 * `V<N>` to index `N - 1`, including V2-only enums, so generated codecs use this
 * helper for versioned wire wrappers.
 */
export function indexedTaggedUnion(variants) {
    const byIndex = new Map();
    for (const [tag, [index, codec]] of Object.entries(variants)) {
        if (!Number.isInteger(index) || index < 0 || index > 255) {
            throw new Error(`Invalid enum discriminant for ${tag}: ${index}`);
        }
        if (byIndex.has(index)) {
            throw new Error(`Duplicate enum discriminant: ${index}`);
        }
        byIndex.set(index, [tag, codec]);
    }
    return createCodec((value) => {
        const variant = variants[value.tag];
        if (!variant) {
            throw new Error(`Unknown enum variant: ${value.tag}`);
        }
        const [index, codec] = variant;
        const payload = codec.enc(value.value);
        const out = new Uint8Array(payload.length + 1);
        out[0] = index;
        out.set(payload, 1);
        return out;
    }, createDecoder((input) => {
        const index = u8.dec(input);
        const variant = byIndex.get(index);
        if (!variant) {
            throw new Error(`Unknown enum discriminant: ${index}`);
        }
        const [tag, codec] = variant;
        return { tag, value: codec.dec(input) };
    }));
}
