/** Dev-only: decode a wire frame's SCALE payload, keyed by `trait * 256 +
 *  method` and then by that frame's own `messageType` byte. Unknown
 *  addresses or message types are absent (caller falls back to bytes). */
export declare const WIRE_DECODE_TABLE: Record<number, Record<number, (payload: Uint8Array) => unknown>>;
