/** SCALE codec primitives used by the generated client.
 *
 * Thin wrapper over `scale-ts`: re-exports its primitives and combinators,
 * plus the Polkadot-flavour helpers it does not ship (hex-encoded bytes,
 * lazy recursive codecs, and `V<N>`-indexed tagged unions).
 */
import { type Codec } from "scale-ts";
export type { Codec };
export type { ResultPayload } from "scale-ts";
export { Bytes, Enum, Option, Result, Struct, Tuple, Vector, _void, bool, compact, i8, i16, i32, i64, i128, str, u8, u16, u32, u64, u128, } from "scale-ts";
/**
 * Substrate `OptionBool`: a one-byte `Option<bool>`.
 *
 * Canonical SCALE encoding (matches `parity_scale_codec::OptionBool`):
 * `undefined` → `0`, `true` → `1`, `false` → `2`.
 */
export declare const OptionBool: Codec<boolean | undefined>;
/** Hex-encoded byte string, e.g. `"0xdeadbeef"`. */
export type HexString = `0x${string}`;
/** Assert that a string is a valid hex string (`0x...`). */
export declare function toHexString(value: string): HexString;
/** Encode a byte array as a lower-case hex string with a `0x` prefix. */
export declare function bytesToHex(bytes: Uint8Array): HexString;
/** Decode a hex string into a byte array. Tolerates a missing `0x` prefix. */
export declare function hexToBytes(hex: string): Uint8Array;
/**
 * SCALE codec for hex-encoded byte strings.
 *
 * Encode accepts a `0x`-prefixed hex string and emits SCALE bytes; decode
 * returns the bytes as a hex string. Pass `length` for fixed-size byte arrays
 * (`[u8; N]`); omit it for variable-length byte vectors (`Vec<u8>`).
 */
export declare function Hex(length?: number): Codec<HexString>;
/**
 * Same wire format as `scale-ts`'s `Enum`, but exposes `value` as optional in
 * the public TS type when the variant codec is `Codec<undefined>`. Lets unit
 * variants of mixed enums round-trip as `{ tag: "X" }` (no `value` key).
 */
export declare function TaggedUnion<O extends TaggedUnionCodecs>(inner: O): Codec<TaggedUnionValue<O>>;
/** Public TS value for Rust's derived `CallError<D>` enum. */
export type CallErrorValue<D> = {
    tag: "Domain";
    value: D;
} | {
    tag: "Denied";
    value?: undefined;
} | {
    tag: "Unsupported";
    value?: undefined;
} | {
    tag: "MalformedFrame";
    value: {
        reason: string;
    };
} | {
    tag: "HostFailure";
    value: {
        reason: string;
    };
};
/** SCALE codec for Rust's derived `CallError<D>` enum. */
export declare function CallError<D>(domain: Codec<D>): Codec<CallErrorValue<D>>;
type TaggedUnionCodecs = {
    [Sym: symbol]: never;
    [Num: number]: never;
    [Str: string]: Codec<any>;
};
type TaggedUnionValue<O extends TaggedUnionCodecs> = {
    [K in keyof O & string]: O[K] extends Codec<infer T> ? [T] extends [undefined] ? {
        tag: K;
        value?: undefined;
    } : {
        tag: K;
        value: T;
    } : never;
}[keyof O & string];
/**
 * Enum without payloads — maps string labels to SCALE discriminant bytes.
 *
 * `scale-ts` models `Enum({ Foo: _void, Bar: _void })` as tagged objects. For
 * user-facing TrUAPI enums with only unit variants, we keep the public TS shape
 * as a plain string union instead.
 */
export declare function Status<const T extends string>(...variants: readonly T[]): Codec<T>;
/**
 * Defers codec construction until first use so recursive generated codecs can
 * reference each other safely.
 */
export declare function lazy<T>(factory: () => Codec<T>): Codec<T>;
type IndexedVariantCodec<T> = readonly [index: number, codec: Codec<T>];
type IndexedVariantValue<Variants extends Record<string, IndexedVariantCodec<any>>, K extends keyof Variants & string> = Variants[K] extends IndexedVariantCodec<infer T> ? [T] extends [undefined] ? {
    tag: K;
    value?: undefined;
} : {
    tag: K;
    value: T;
} : never;
/**
 * Builds a tagged union codec with explicit SCALE discriminants.
 *
 * `scale-ts` assigns enum indexes by object key order. TrUAPI versioned enums pin
 * `V<N>` to index `N - 1`, including V2-only enums, so generated codecs use this
 * helper for versioned wire wrappers.
 */
export declare function indexedTaggedUnion<Variants extends Record<string, IndexedVariantCodec<any>>>(variants: Variants): Codec<{
    [K in keyof Variants & string]: IndexedVariantValue<Variants, K>;
}[keyof Variants & string]>;
