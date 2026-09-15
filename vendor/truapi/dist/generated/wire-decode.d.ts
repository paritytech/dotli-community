/** Dev-only: decode a wire frame's SCALE payload to a plain JS value, keyed by frameId.
 *  Request/response/subscription frames only; unknown ids are absent (caller falls back to bytes). */
export declare const WIRE_DECODE_TABLE: Record<number, (payload: Uint8Array) => unknown>;
